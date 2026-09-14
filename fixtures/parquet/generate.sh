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
SQL

DUCKDB_VERSION="$("$DUCKDB" --version)"

python3 - "$DUCKDB_VERSION" <<'PY'
import hashlib, json, sys, pathlib

duckdb_version = sys.argv[1].split()[0]
descriptions = {
    "customers.parquet": "Typed CSV import incl. NULL income value",
    "nested.parquet": "Nested structs/lists with nullable inner fields (50 rows)",
    "llm.parquet": "LLM chat/eval records, list-of-structs, incl. missing system turn",
    "wide.parquet": "Multi-row-group (10 x 100), nulls, low-cardinality bucket column",
}
files = []
for name, description in sorted(descriptions.items()):
    digest = hashlib.sha256(pathlib.Path(name).read_bytes()).hexdigest()
    files.append({"name": name, "sha256": digest, "description": description})

manifest = {
    "generator": "fixtures/parquet/generate.sh (ADR 0038)",
    "duckdb_version": duckdb_version,
    "policy": "Small canonical fixtures are committed. Large performance fixtures are generated on demand and never committed. Regeneration changes checksums by design; commit the updated manifest deliberately.",
    "files": files,
}
pathlib.Path("manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
print("manifest.json written for", len(files), "fixtures")
PY

echo "done: $(ls *.parquet | wc -l) parquet fixtures + manifest.json"
