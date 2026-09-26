import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { sha256File } from './hash'

// q-5: the chunked sha256 file hash now lives in ./hash (one definition);
// re-exported here so the hermetic reuse spec's existing import path works.
export { sha256File }

/**
 * On-demand ~1 GiB Parquet fixture for the m1-7 time-to-first-row / memory
 * benchmark (fixtures/parquet/manifest.json policy: "Large performance
 * fixtures are generated on demand and never committed"; the ~1 GiB file
 * lives only in the OS temp dir).
 *
 * Deterministic (ADR 0038 spirit: no random, no clocks): the SQL depends only
 * on row index i and DuckDB's version-pinned `hash()`/`md5()` — two runs with
 * the same CLI produce byte-identical files (sha256 recorded in the sidecar
 * meta). Hash stability is a DuckDB implementation detail, so determinism is
 * claimed for the CI-pinned CLI (1.5.5) only.
 *
 * Shape (chosen for a realistic mixed workload — see the m1-7 benchmark note):
 *   id         BIGINT     unique, ascending (zone-map friendly)
 *   cat        INTEGER    categorical, 1000 buckets
 *   value      DOUBLE     pseudo-random via hash(i) (defeats zone maps)
 *   label      VARCHAR    varying width 13–37 chars, high entropy (md5-based)
 *   note       VARCHAR    ~72 chars, high entropy — the compression payload
 *   maybe_null DOUBLE     NULL every 10th row (the nullable column)
 *   tags       VARCHAR[]  list column, 0–2 md5-based elements
 *
 * Sizing: 16M rows → ~1.09 GiB on disk (zstd, 122_880-row groups), measured
 * with DuckDB CLI 1.5.5. Generation ~25 s. Column names are a contract with
 * the bench steps in the harness (packages/engine-duckdb/harness/main.ts) and
 * tests/e2e/bench-ttfr.spec.ts.
 *
 * Reuse policy (unlike million-fixture.ts, which always overwrites): if the
 * temp file exists and its sidecar meta agrees with the file on disk —
 * `rows` and `bytes`, plus the stored `sha256` re-hashed from the actual
 * file (a few seconds for ~1 GiB) — it is reused. A same-size corrupted file
 * fails the sha256 comparison and is regenerated instead of poisoning the
 * bench (decision factored into `metaMatches` so the negative e2e test can
 * pin it; m1-7 reviewer carry-over: the old rows+bytes-only check reused a
 * same-size corrupt file). Delete the temp dir (or set ASSAY_E2E_BIG_ROWS)
 * to force regeneration. The DuckDB CLI is resolved from `DUCKDB` (default
 * `duckdb` on PATH), same as million-fixture.ts.
 */

/** Env override for tuning/fallback runs (e.g. `ASSAY_E2E_BIG_ROWS=4000000`). */
export const BIG_ROW_COUNT = Number(process.env['ASSAY_E2E_BIG_ROWS'] ?? 16_000_000)

/** Row-group size large enough to stay out of the way (matches million-fixture). */
const ROW_GROUP_SIZE = 122_880

/** Fixed temp-dir location so specs and setup agree without shared process state. */
export function bigFixtureDir(): string {
  return path.join(tmpdir(), 'assay-e2e-m1-7')
}

export function bigFixturePath(): string {
  return path.join(bigFixtureDir(), 'big.parquet')
}

function bigFixtureMetaPath(): string {
  return path.join(bigFixtureDir(), 'big.meta.json')
}

/**
 * What the generator persists in the sidecar meta (big.meta.json). Fields
 * are optional in the type because the JSON is untrusted input: a meta
 * missing any of them must fail `metaMatches` and trigger regeneration.
 */
export interface BigFixtureMeta {
  readonly rows?: number
  readonly bytes?: number
  readonly sha256?: string
}

/**
 * The reuse decision, factored out so the negative e2e test can prove that a
 * same-size corrupted fixture is rejected (the old rows+bytes-only decision
 * would have reused it). The meta matches only when its `rows`/`bytes` agree
 * with the reuse candidate AND its stored `sha256` equals the hash of the
 * actual file; a meta without a usable `sha256` never matches, because it
 * cannot be verified.
 *
 * @param meta   parsed sidecar meta (untrusted JSON)
 * @param stat   the reuse candidate: `rows` as requested (env) and the
 *               on-disk file's `bytes`
 * @param sha256 sha256 of the actual on-disk file
 */
export function metaMatches(
  meta: BigFixtureMeta,
  stat: { readonly rows: number; readonly bytes: number },
  sha256: string,
): boolean {
  return (
    meta.rows === stat.rows &&
    meta.bytes === stat.bytes &&
    stat.bytes > 0 &&
    typeof meta.sha256 === 'string' &&
    meta.sha256 === sha256
  )
}

/** Facts about the generated fixture, logged for the benchmark note. */
export interface BigFixtureInfo {
  readonly path: string
  readonly rows: number
  readonly bytes: number
  readonly generationMs: number
  readonly sha256: string
}

/**
 * The exact COPY statement producing the fixture. Kept as data so the
 * generator and any manual reproduction (benchmark note) stay in sync.
 */
export function bigFixtureSql(rows: number, destination: string): string {
  const dest = destination.replaceAll("'", "''")
  return [
    'COPY (',
    '  SELECT',
    '    i AS id,',
    '    CAST(i % 1000 AS INTEGER) AS cat,',
    '    ((hash(i) % 1000000) / 7.0)::DOUBLE AS value,',
    "    'item-' || substring(md5(i::VARCHAR), 1, 8 + (i % 25)) AS label,",
    "    'note ' || md5((i * 3)::VARCHAR) || ' ' || md5((i * 7)::VARCHAR) AS note,",
    '    CASE WHEN i % 10 = 0 THEN NULL ELSE ((hash(i * 13) % 100000) / 7.0)::DOUBLE END AS maybe_null,',
    '    CASE',
    '      WHEN i % 5 = 0 THEN []::VARCHAR[]',
    '      WHEN i % 3 = 0 THEN [md5((i + 1)::VARCHAR), md5((i + 2)::VARCHAR)]',
    '      ELSE [md5((i + 1)::VARCHAR)]',
    '    END AS tags',
    `  FROM range(${String(rows)}) t(i)`,
    `) TO '${dest}'`,
    `(FORMAT PARQUET, ROW_GROUP_SIZE ${String(ROW_GROUP_SIZE)}, COMPRESSION ZSTD);`,
    '',
  ].join('\n')
}

/**
 * Generate the fixture (or reuse a byte-identical existing one). Throws with
 * an actionable message when no DuckDB CLI is available.
 */
export function ensureBigFixture(): BigFixtureInfo {
  const rows = BIG_ROW_COUNT
  if (!Number.isSafeInteger(rows) || rows <= 0) {
    throw new Error(`ASSAY_E2E_BIG_ROWS must be a positive integer, got: ${String(rows)}`)
  }
  mkdirSync(bigFixtureDir(), { recursive: true })
  const fixturePath = bigFixturePath()
  const metaPath = bigFixtureMetaPath()

  if (existsSync(fixturePath) && existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as BigFixtureMeta
      const bytes = statSync(fixturePath).size
      const started = Date.now()
      const sha256 = sha256File(fixturePath)
      if (metaMatches(meta, { rows, bytes }, sha256)) {
        const info: BigFixtureInfo = {
          path: fixturePath,
          rows,
          bytes,
          generationMs: 0, // reused, not regenerated (Date.now only for the log line)
          sha256,
        }
        console.log(
          `[m1-7 fixture] reused ${fixturePath} rows=${String(info.rows)} bytes=${String(info.bytes)} ` +
            `gib=${(info.bytes / 1024 ** 3).toFixed(3)} sha256=${info.sha256} (meta+sha256 match; verify=${String(Date.now() - started)}ms)`,
        )
        return info
      }
      console.log(
        `[m1-7 fixture] meta mismatch for ${fixturePath} (stored rows=${String(meta.rows)} ` +
          `bytes=${String(meta.bytes)} sha256=${String(meta.sha256 ?? 'none')}; actual bytes=${String(bytes)} ` +
          `sha256=${sha256}) — regenerating`,
      )
    } catch {
      // Unreadable/corrupt meta: fall through to regeneration.
    }
  }

  const cli = process.env['DUCKDB'] ?? 'duckdb'
  try {
    execFileSync(cli, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    throw new Error(
      `DuckDB CLI not found (tried: ${cli}). The m1-7 bench generates a ~1 GiB ` +
        'Parquet fixture on demand; install the CLI or set DUCKDB=/path/to/duckdb.',
    )
  }
  const started = Date.now()
  execFileSync(cli, { input: bigFixtureSql(rows, fixturePath), stdio: ['pipe', 'pipe', 'inherit'] })
  const generationMs = Date.now() - started
  const bytes = statSync(fixturePath).size
  if (bytes === 0) {
    throw new Error('fixture generation produced an empty file')
  }
  const sha256 = sha256File(fixturePath)
  writeFileSync(
    metaPath,
    JSON.stringify({ rows, bytes, generationMs, sha256, generator: 'duckdb 1.5.5 zstd' }, null, 2) +
      '\n',
  )
  const info: BigFixtureInfo = { path: fixturePath, rows, bytes, generationMs, sha256 }
  console.log(
    `[m1-7 fixture] generated ${fixturePath} rows=${String(info.rows)} bytes=${String(info.bytes)} ` +
      `gib=${(info.bytes / 1024 ** 3).toFixed(3)} generationMs=${String(info.generationMs)} sha256=${info.sha256}`,
  )
  return info
}
