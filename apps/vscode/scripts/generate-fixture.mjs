// SPDX-License-Identifier: AGPL-3.0-or-later
/* global process, console */

/**
 * Generate the on-demand 1M-row Parquet fixture for the Q5 memory/TTFR probe.
 *
 * The SQL is copied verbatim from the committed e2e generator
 * (`tests/e2e/support/million-fixture.ts`) so the spike measures the exact
 * shape the M1-5/G1-R web numbers used — never committed (fixtures policy:
 * large performance fixtures are generated on demand). Idempotent: reuses an
 * existing non-empty file. Prints the fixture path on stdout.
 *
 * Requires the DuckDB CLI: `DUCKDB=/tmp/duckdb node scripts/generate-fixture.mjs`.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const cli = process.env['DUCKDB'] ?? 'duckdb'
const dir = path.join(tmpdir(), 'assay-e2e-m1-5')
const fixturePath = path.join(dir, 'million.parquet')

if (existsSync(fixturePath) && statSync(fixturePath).size > 0) {
  console.log(fixturePath)
  process.exit(0)
}

mkdirSync(dir, { recursive: true })
const sql = [
  'COPY (',
  '  SELECT',
  '    i AS id,',
  '    i % 1000 AS bucket,',
  "    'row-' || i AS label,",
  '    CASE WHEN i % 100000 = 0 THEN NULL ELSE CAST(i * 1.5 AS DOUBLE) END AS value_maybe_null',
  '  FROM range(1000000) t(i)',
  `) TO '${fixturePath.replaceAll("'", "''")}'`,
  '(FORMAT PARQUET, ROW_GROUP_SIZE 122880, COMPRESSION ZSTD);',
  '',
].join('\n')
execFileSync(cli, { input: sql, stdio: ['pipe', 'pipe', 'inherit'] })
if (statSync(fixturePath).size === 0) {
  throw new Error('fixture generation produced an empty file')
}
console.log(fixturePath)
