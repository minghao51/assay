// SPDX-License-Identifier: AGPL-3.0-or-later
/* global process, console */

/**
 * Generate the COMMITTED e2e fixtures (ptv1-3) — deliberately tiny, fully
 * synthetic, value-free:
 *   - test/fixtures/synthetic-smoke.parquet — 5 rows x 4 columns
 *     (id/bucket/label/value_maybe_null, the spike fixture's shape), so the
 *     e2e exercises the real Parquet path (the vendored extension serve).
 *   - test/fixtures/empty.csv — 0 bytes, for the empty-file typed error.
 *
 * Committed so the e2e runs offline once the VS Code cache exists; regenerate
 * ONLY deliberately (the committed bytes are the pin). Requires the DuckDB
 * CLI: `DUCKDB=/path/to/duckdb node scripts/generate-fixtures.mjs`.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(here, '..')
const fixturesDir = path.join(appRoot, 'test', 'fixtures')
const parquetPath = path.join(fixturesDir, 'synthetic-smoke.parquet')
const emptyPath = path.join(fixturesDir, 'empty.csv')

mkdirSync(fixturesDir, { recursive: true })

const cli = process.env['DUCKDB'] ?? 'duckdb'
if (!existsSync(parquetPath)) {
  const sql = [
    'COPY (',
    '  SELECT',
    '    i AS id,',
    '    i % 2 AS bucket,',
    "    'row-' || i AS label,",
    '    CASE WHEN i = 0 THEN NULL ELSE CAST(i * 1.5 AS DOUBLE) END AS value_maybe_null',
    '  FROM range(5) t(i)',
    `) TO '${parquetPath.replaceAll("'", "''")}'`,
    '(FORMAT PARQUET);',
    '',
  ].join('\n')
  execFileSync(cli, { input: sql, stdio: ['pipe', 'pipe', 'inherit'] })
}

// The 0-byte CSV is part of the fixture set (the empty-file typed error path).
writeFileSync(emptyPath, '')

for (const file of [parquetPath, emptyPath]) {
  const bytes = statSync(file).size
  const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex')
  console.log(`${path.relative(appRoot, file)}  ${String(bytes)} bytes  sha256=${sha256}`)
}
