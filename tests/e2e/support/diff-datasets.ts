import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * On-demand dataset pairs for the m6-4 web diff journeys (the m5-2/m5-3
 * pattern: runtime-built temp files, NEVER committed, deterministic
 * row-for-row). Every expected count below was derived with the pinned
 * DuckDB CLI (v1.5.5, `DUCKDB=/tmp/duckdb`) running the REAL m6-1 compiler's
 * plan over the identical JSONL (see the m6-4 worker derivation), plus the
 * m2-5 profile SQL for the distribution metrics.
 *
 * Pair (A = the open/reference dataset, B = the staged comparison):
 *
 *   A (5 rows): id 1..5, name a1..a5, amount 10..50
 *   B (5 rows): id/name/amount with:
 *     - id 2 name a2 -> b2            (changed: ['name'])
 *     - id 3 amount 30 -> 99          (changed: ['amount'])
 *     - id 4, id 5 absent             (removed: A ordinals 3, 4)
 *     - id 6, id 7 added              (added: B ordinals 3, 4)
 *     - a new column `region`         (schema drift: column-added)
 *
 *   row diff on key id: added 2 (b:3, b:4), removed 2 (base #3, base #4),
 *   changed 2 (base #1 ['name'], base #2 ['amount']); shared non-key columns
 *   [name, amount].
 *
 *   profile deltas (native CLI): id mean shift 0.505964, variance shift
 *   1.68; name categorical TV 0.6 with new [a6, a7, b2] / vanished
 *   [a2, a4, a5]; amount mean shift 1.378753, variance shift 4.3848.
 *
 * Privacy (ADR 0025): the rows are synthetic and committed nowhere; no file
 * names or dataset values are logged by the engine or the spec.
 */

export interface DiffDatasetPair {
  /** Path of side A (opened through the app's open flow). */
  readonly aPath: string
  /** Path of side B (staged through the comparison control). */
  readonly bPath: string
}

const A_ROWS: readonly string[] = [
  '{"id":1,"name":"a1","amount":10}',
  '{"id":2,"name":"a2","amount":20}',
  '{"id":3,"name":"a3","amount":30}',
  '{"id":4,"name":"a4","amount":40}',
  '{"id":5,"name":"a5","amount":50}',
]

const B_ROWS: readonly string[] = [
  '{"id":1,"name":"a1","amount":10,"region":"x"}',
  '{"id":2,"name":"b2","amount":20,"region":"x"}',
  '{"id":3,"name":"a3","amount":99,"region":"y"}',
  '{"id":6,"name":"a6","amount":60,"region":"x"}',
  '{"id":7,"name":"a7","amount":70,"region":"x"}',
]

/** Stage a fresh A/B pair into a temp dir (never committed). */
export function writeDiffDatasetPair(): DiffDatasetPair {
  const dir = mkdtempSync(path.join(tmpdir(), 'assay-m6-4-diff-'))
  const aPath = path.join(dir, 'orders-a.jsonl')
  const bPath = path.join(dir, 'orders-b.jsonl')
  writeFileSync(aPath, A_ROWS.join('\n') + '\n')
  writeFileSync(bPath, B_ROWS.join('\n') + '\n')
  return { aPath, bPath }
}

/**
 * A pair whose ONLY difference is that two rows' `amount` values are swapped
 * (id 1 ↔ id 2). The schema is identical and the multiset of `amount`
 * values — hence every profile aggregate (mean, variance, quantiles) — is
 * byte-for-byte the same, so the schema/profile aspects are flat while the
 * keyed row diff still finds two changed rows. This is the reachable state
 * the m6-4 review warning named: `diff-schema-profile-none` renders after a
 * row diff that found differences, so the pre-run "Choose keys…" instruction
 * must not appear there.
 */
export function writeSwappedDiffPair(): DiffDatasetPair {
  const dir = mkdtempSync(path.join(tmpdir(), 'assay-m6-4-swap-'))
  const aPath = path.join(dir, 'orders-a.jsonl')
  const bPath = path.join(dir, 'orders-b.jsonl')
  const swappedB = [
    '{"id":1,"name":"a1","amount":20}',
    '{"id":2,"name":"a2","amount":10}',
    '{"id":3,"name":"a3","amount":30}',
    '{"id":4,"name":"a4","amount":40}',
    '{"id":5,"name":"a5","amount":50}',
  ]
  writeFileSync(aPath, A_ROWS.join('\n') + '\n')
  writeFileSync(bPath, swappedB.join('\n') + '\n')
  return { aPath, bPath }
}

/** Stage an identical pair (two byte-identical files) into a temp dir. */
export function writeIdenticalDiffPair(): DiffDatasetPair {
  const dir = mkdtempSync(path.join(tmpdir(), 'assay-m6-4-same-'))
  const aPath = path.join(dir, 'orders-a.jsonl')
  const bPath = path.join(dir, 'orders-same.jsonl')
  const rows = A_ROWS.join('\n') + '\n'
  writeFileSync(aPath, rows)
  writeFileSync(bPath, rows)
  return { aPath, bPath }
}
