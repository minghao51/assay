#!/usr/bin/env bash
# Generate golden Parquet fixtures deterministically (ADR 0038).
#
# Requirements: DuckDB CLI on PATH (or set DUCKDB=/path/to/duckdb).
#   https://duckdb.org/docs/installation/
#
# Policy: small canonical fixtures are committed together with manifest.json.
# Regeneration changes checksums; commit the updated manifest deliberately.

set -euo pipefail

DUCKDB="${DUCKDB:-duckdb}"
command -v "$DUCKDB" >/dev/null 2>&1 || {
  echo "error: DuckDB CLI not found (tried: $DUCKDB)" >&2
  echo "       install: https://duckdb.org/docs/installation/ or set DUCKDB=/path/to/duckdb" >&2
  exit 1
}

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here"

# All SQL is deterministic: no unseeded random(), no current-time functions.
"$DUCKDB" <<'SQL'
-- 1. Typed CSV import with a NULL income value (null-handling conformance).
COPY (
  SELECT * FROM read_csv('../csv/customers.csv', header = true)
) TO 'customers.parquet' (FORMAT PARQUET, COMPRESSION ZSTD);

-- 2. Nested structures: structs-in-structs, lists, nullable inner fields.
COPY (
  SELECT
    i AS id,
    {
      'name': 'n' || i,
      'geo': {'lat': 1.0 + (i % 90), 'lon': 2.0 + (i % 80)},
      'tags': CASE WHEN i % 3 = 0 THEN ['x'] WHEN i % 3 = 1 THEN ['x', 'x'] ELSE ['x', 'x', 'x'] END,
      'scores': {'q1': ((i % 10)::DOUBLE / 10), 'q2': NULL}
    } AS payload
  FROM range(50) t(i)
) TO 'nested.parquet' (FORMAT PARQUET, COMPRESSION ZSTD);

-- 3. LLM chat/eval records with list-of-structs (deliberately includes a
--    conversation missing a system turn).
COPY (
  SELECT * FROM read_json_auto('../llm/chat-eval.jsonl')
) TO 'llm.parquet' (FORMAT PARQUET, COMPRESSION ZSTD);

-- 4. Multi-row-group file: 1000 rows in 10 row groups of 100, with nulls and
--    a dictionary-friendly low-cardinality column.
COPY (
  SELECT
    i AS id,
    'row_' || i AS label,
    (i * 7) % 100 AS bucket,
    CASE WHEN i % 3 = 0 THEN NULL ELSE i * 1.5 END AS value_maybe_null
  FROM range(1000) t(i)
) TO 'wide.parquet' (FORMAT PARQUET, ROW_GROUP_SIZE 100, COMPRESSION ZSTD);

-- 5. Temporal column families (wf-01 display conformance). A declared temporal
--    type only survives a Parquet round-trip, so this fixture is the only way
--    to open DATE / TIMESTAMP / TIMESTAMP_NS / TIME through the real engine.
--    Rows (deliberately ordered least→most degenerate):
--      0 leap day + microseconds (DATE, TIMESTAMP µs, TIME µs)
--      1 pre-1970 sub-millisecond instant (`-0.001` ms at the epoch)
--      2 midnight / whole second (DATE), and a millisecond-exact
--        TIMESTAMP_NS value — the fraction WIDTH follows the value there,
--        so it renders `.123Z` while row 0's ns payload stays raw
--      3 the all-NULL row
COPY (
  SELECT * FROM (
    VALUES
      (DATE '2024-02-29', TIMESTAMP '2024-02-29 13:45:12.123456',
       TIMESTAMP_NS '2024-02-29 13:45:12.123456789', TIME '13:45:12.123456'),
      (DATE '1969-12-31', TIMESTAMP '1969-12-31 23:59:59.999999',
       TIMESTAMP_NS '1969-12-31 23:59:59.999999999', TIME '23:59:59.999999'),
      (DATE '1970-01-01', TIMESTAMP '2024-02-29 00:00:00',
       TIMESTAMP_NS '2024-02-29 13:45:12.123', TIME '00:00:00'),
      (NULL, NULL, NULL, NULL)
  ) AS t(d, ts, ts_ns, t)
) TO 'temporal.parquet' (FORMAT PARQUET, COMPRESSION ZSTD);

-- 6. DuckDB ±infinity TIMESTAMP sentinels (R2 projection-boundary guard, D6).
--    The sentinels are the two int64 extremes; Arrow's `get()` throws on them
--    for Timestamp<SECOND>/<MILLISECOND>/<MICROSECOND> before any formatter
--    runs, so the grid needs the projection guard under test here. Rows
--    (deliberately ordered: finite controls around the sentinels):
--      0 finite µs timestamp (year 2400) + finite ns value near the ns int64
--        maximum — the negative controls that must never read as infinity
--      1 TIMESTAMP 'infinity' (µs sentinel) + TIMESTAMP_NS 'infinity' — the
--        ns sentinel must NOT throw and must stay raw (WF-01 ns rule)
--      2 TIMESTAMP '-infinity' (negative sentinel) + finite pre-1970 ns
--      3 finite µs with fraction + finite ns with fraction
COPY (
  SELECT * FROM (
    VALUES
      (TIMESTAMP '2400-01-01 00:00:00', TIMESTAMP_NS '2262-04-10 00:00:00.123456789', 'finite-late'),
      (TIMESTAMP 'infinity', TIMESTAMP_NS 'infinity', 'infinity'),
      (TIMESTAMP '-infinity', TIMESTAMP_NS '1969-12-31 23:59:59.999999999', '-infinity'),
      (TIMESTAMP '2024-02-29 13:45:12.123456', TIMESTAMP_NS '2024-02-29 13:45:12.123456789', 'finite-early')
  ) AS t(ts, ts_ns, label)
) TO 'temporal-infinity.parquet' (FORMAT PARQUET, COMPRESSION ZSTD);
SQL

DUCKDB_VERSION="$("$DUCKDB" --version)"

DUCKDB_VERSION="$DUCKDB_VERSION" node --input-type=module <<'JS'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const duckdbVersion = process.env.DUCKDB_VERSION.trim().split(/\s+/)[0]
const descriptions = {
  'customers.parquet': 'Typed CSV import incl. NULL income value',
  'nested.parquet': 'Nested structs/lists with nullable inner fields (50 rows)',
  'llm.parquet': 'LLM chat/eval records, list-of-structs, incl. missing system turn',
  'wide.parquet': 'Multi-row-group (10 x 100), nulls, low-cardinality bucket column',
  'temporal.parquet':
    'Temporal families: DATE, TIMESTAMP (microseconds), TIMESTAMP_NS (lossy delivery), TIME; NULL/pre-1970/leap-day rows (4 rows)',
  'temporal-infinity.parquet':
    'DuckDB ±infinity TIMESTAMP sentinels (the int64 extremes) with finite µs negative controls and a TIMESTAMP_NS raw-class column incl. ns infinity (4 rows)',
}
const files = Object.entries(descriptions)
  .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  .map(([name, description]) => ({
    name,
    sha256: createHash('sha256').update(readFileSync(name)).digest('hex'),
    description,
  }))

const manifest = {
  generator: 'fixtures/parquet/generate.sh (ADR 0038)',
  duckdb_version: duckdbVersion,
  policy: 'Small canonical fixtures are committed. Large performance fixtures are generated on demand and never committed. Regeneration changes checksums by design; commit the updated manifest deliberately.',
  files,
}
writeFileSync('manifest.json', JSON.stringify(manifest, null, 2) + '\n')
console.log('manifest.json written for', files.length, 'fixtures')
JS

echo "done: $(ls *.parquet | wc -l) parquet fixtures + manifest.json"
