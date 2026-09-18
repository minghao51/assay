import { execFileSync } from 'node:child_process'
import { mkdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * On-demand 1M-row Parquet fixture for the m1-5 virtualization e2e
 * (fixtures/parquet/manifest.json policy: "Large performance fixtures are
 * generated on demand and never committed").
 *
 * Generation is fully deterministic (ADR 0038: no random, no clocks), so row
 * `i` always holds the values of `expectedMillionRow(i)` — the e2e can assert
 * exact cell contents at arbitrary scroll offsets. A parallel CI task installs
 * the DuckDB CLI into the e2e job; locally the CLI is resolved from `DUCKDB`
 * (default `duckdb` on PATH).
 */

export const MILLION_ROW_COUNT = 1_000_000

/** Row-group size large enough to stay out of the way; single row group. */
const ROW_GROUP_SIZE = 122_880

/** The deterministic cell values of row `index`, exactly as generated. */
export interface MillionRowExpectation {
  readonly id: string
  readonly bucket: string
  readonly label: string
  readonly valueMaybeNull: string // 'NULL' for the generator's NULLs (m4-3 marker)
}

export function expectedMillionRow(index: number): MillionRowExpectation {
  return {
    id: String(index),
    bucket: String(index % 1000),
    label: `row-${String(index)}`,
    // Every 100,000th row carries a NULL. i * 1.5 is exact in binary floating
    // point for i ≤ 1e6 (integers and halves), so JS String() and DuckDB's
    // DECIMAL→DOUBLE cast agree digit for digit. m4-3 renders a SQL NULL as the
    // distinct `NULL` marker (never a blank cell), hence the string here.
    valueMaybeNull: index % 100_000 === 0 ? 'NULL' : String(index * 1.5),
  }
}

/** Fixed temp-dir location so specs and setup agree without shared process state. */
export function millionFixtureDir(): string {
  return path.join(tmpdir(), 'assay-e2e-m1-5')
}

export function millionFixturePath(): string {
  return path.join(millionFixtureDir(), 'million.parquet')
}

/**
 * Generate the fixture (idempotent: overwrites). Throws with an actionable
 * message when no DuckDB CLI is available. Returns the fixture path.
 */
export function ensureMillionFixture(): string {
  const cli = process.env['DUCKDB'] ?? 'duckdb'
  try {
    execFileSync(cli, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    throw new Error(
      `DuckDB CLI not found (tried: ${cli}). The m1-5 e2e generates a 1M-row ` +
        'Parquet fixture on demand; install the CLI or set DUCKDB=/path/to/duckdb.',
    )
  }
  mkdirSync(millionFixtureDir(), { recursive: true })
  const fixturePath = millionFixturePath()
  const sql = [
    'COPY (',
    '  SELECT',
    '    i AS id,',
    '    i % 1000 AS bucket,',
    "    'row-' || i AS label,",
    '    CASE WHEN i % 100000 = 0 THEN NULL ELSE CAST(i * 1.5 AS DOUBLE) END AS value_maybe_null',
    `  FROM range(${String(MILLION_ROW_COUNT)}) t(i)`,
    `) TO '${fixturePath.replaceAll("'", "''")}'`,
    `(FORMAT PARQUET, ROW_GROUP_SIZE ${String(ROW_GROUP_SIZE)}, COMPRESSION ZSTD);`,
    '',
  ].join('\n')
  execFileSync(cli, { input: sql, stdio: ['pipe', 'pipe', 'inherit'] })
  const size = statSync(fixturePath).size
  if (size === 0) {
    throw new Error('fixture generation produced an empty file')
  }
  return fixturePath
}
