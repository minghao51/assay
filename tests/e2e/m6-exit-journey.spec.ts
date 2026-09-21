import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Download, Page } from '@playwright/test'
import {
  writeExitJourneyIdenticalPair,
  writeExitJourneyOverKPair,
  writeExitJourneyPair,
} from './support/diff-datasets'

// Task m6-5 (handoff §6) — the M6 EXIT JOURNEY, the final MVP task: the two
// diff surfaces must agree EXACTLY on the same two files, and the docs-07
// honesty order (schema drift → profile deltas → row diff) must be visible
// on both, with a real privacy sweep and no honesty gaps.
//
// "Same two files" is literal: ONE A/B pair is staged into a fresh temp dir
// (runtime-built, deterministic, never committed — the m6-2/m6-4 on-demand
// pattern), the browser opens A through the real open flow and stages B
// through the real comparison control, and the CLI process is spawned
// (`node --import tsx src/index.ts diff … --infer --sample-limit 100
// --format json`) against the SAME two paths. The `--sample-limit 100` makes
// both sides sit at the engine hard max (`DIFF_SAMPLE_LIMIT` /
// `ROW_DIFF_SAMPLE_HARD_MAX`), so `sampleLimitRequested` and
// `sampleLimitEffective` are comparable field for field (the m5-6
// K-matching pattern).
//
// ## Exact agreement — asserted, not sampled
//
// The web report is extracted via the panel's JSON export (download → read
// from disk); the CLI report via `assay diff --format json`. After removing
// exactly the two documented surface-specific differences — the web export
// OMITS the CLI's `a`/`b` basenames (privacy, ADR-style panel rule) and ADDS
// `stale` (the m5-3 freshness rule, `false` in the agreement leg) — the two
// objects are compared field for field, and BOTH are pinned to the
// expectation independently derived below. That triple pin means neither
// surface can carry an undeclared finding/delta/sample: every schema-drift
// finding, every column's rendered drift metrics, every row-diff count AND
// sample set (and the `keys` / `keySource` / `inference` disclosure strings
// / `sampleLimit*` / `issues` / `identical` verdict) is asserted, not
// sampled.
//
// ## The independently derived expectation
//
// Every number in EXPECTED was derived with `/tmp/duckdb` v1.5.5 (the pinned
// fixture engine, ADR 0038) running the documented m2-5 profile SQL plus the
// REAL `@assay/diff` functions (`diffDatasets`, `roundForReport`,
// `inferRowDiffKeys`, `compileRowDiffPlan` executed on the emitted SQL) via a
// tsx scratch driver — never from either surface's own output. The projection
// (rounded `nullShare*`, rounded numeric metrics) is byte-for-byte the one
// both renderers apply.
//
// ## Sample semantics (the m6-2 contract)
//
// A-side samples carry `base:<ordinal>` (anchor-free) and B-side `b:<ordinal>`
// on BOTH surfaces: the host anchor fingerprint never leaves the app. The
// engine's `readDiffAspectRows` normalizes the plan's LIMIT-selected set to
// ascending ordinal order, so on this fixture (all ordinals distinct) the
// exported sample order is fully determined and compared as an ordered list;
// the same six pairs are also compared as a canonical multiset so an
// order-only divergence cannot hide a set divergence. `changed` samples are
// pair counts with per-pair changed-column lists (duplicate A-side ordinals
// would be legal — none occur here).
//
// ## The >K caveat
//
// In the main leg every aspect's count is 2 ≤ K=100, so the plan's LIMIT
// selects the ENTIRE differing set and the full-set assertion IS the
// selected-set assertion (`samplesComplete: true`, `sampleLimitEffective:
// 100` on both sides). The zero leg has 0/0/0. The m6-2 >K carry-over — the
// selected set under a PARTIAL `LIMIT` — is pinned by a dedicated third leg:
// one A row vs 121 B rows (120 added > K=100) whose count/returned/complete
// flags and EXACT selected `b:1`..`b:100` set are asserted identically on
// both surfaces (the plan SQL has no ORDER BY, so the selected set is the
// engine's scan order; the pinned engines agree, and a future selection
// divergence fails loudly rather than passing silently).
//
// ## The zero-difference leg
//
// The identical-files case must agree too: both surfaces report
// `identical: true`, 0/0/0 row diff, no schema drift, flat deltas, and the
// CLI exits 0. It is cheap and pins the 0-case agreement.
//
// ## Privacy sweep (ADR 0025 discipline)
//
// Neither file name is rendered on the page; the web export carries no
// paths, names, or anchor tokens; the CLI report names the dataset by
// BASENAME only (the documented byte-stable m6-3 envelope) and never carries
// the temp directory; CLI stderr is byte-empty on every happy-path run; and
// no console/page message observed during the journey carries a file name or
// a dataset value.

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const CLI_DIR = path.join(REPO_ROOT, 'apps/cli')

/**
 * One row-diff sample exactly as both exports carry it: `{side, rowKey}`,
 * plus `changedColumns` on the `changed` aspect.
 */
interface DiffSample {
  readonly side: 'A' | 'B'
  readonly rowKey: string
  readonly changedColumns?: readonly string[]
}

interface DiffAspect {
  readonly count: number
  readonly samplesReturned: number
  readonly samplesComplete: boolean
  readonly samples: readonly DiffSample[]
}

interface DiffInference {
  readonly columns: readonly string[]
  readonly candidateDisclosure: string
  readonly outcomeDisclosure: string
  readonly evidence: {
    readonly column: string
    readonly typeA: string
    readonly typeB: string
    readonly rowCountA: number
    readonly rowCountB: number
    readonly nullCountA: number
    readonly nullCountB: number
    readonly distinctCountA: number
    readonly distinctCountB: number
  }
}

/** The shared report envelope (web export ≡ CLI `--format json` ± two fields). */
interface DiffEnvelope {
  readonly report: string
  readonly baseViewOnly: boolean
  /** CLI-only. */
  readonly a?: { readonly name: string; readonly format: string }
  /** CLI-only. */
  readonly b?: { readonly name: string; readonly format: string }
  /** Web-only. */
  readonly stale: boolean
  readonly keys: readonly string[]
  readonly keySource: string
  readonly inference: DiffInference | null
  readonly sampleLimitRequested: number
  readonly sampleLimitEffective: number
  readonly schemaDrift: readonly unknown[]
  readonly columnDeltas: readonly unknown[]
  readonly rowDiff: {
    readonly rowCountA: number
    readonly rowCountB: number
    readonly changedComparable: boolean
    readonly added: DiffAspect
    readonly removed: DiffAspect
    readonly changed: DiffAspect
  }
  readonly issues: readonly unknown[]
  readonly identical: boolean
}

/**
 * The independently derived expectation for the exit-journey pair — the full
 * normalized envelope, WITHOUT the two surface-specific fields (`a`/`b` and
 * `stale`). See the module comment for the derivation.
 */
const EXPECTED = {
  report: 'assay-diff-report',
  baseViewOnly: true,
  keys: ['id'],
  keySource: 'inferred',
  inference: {
    columns: ['id'],
    candidateDisclosure:
      "key candidate: column 'id' is unique and non-null on both sides (A: BIGINT, 0 nulls, 5 distinct of 5 rows; B: BIGINT, 0 nulls, 5 distinct of 5 rows)",
    outcomeDisclosure:
      '3 key candidate(s) proposed (single columns the profiles prove non-null and unique on both sides, ranked by profile-A column order); inference is a proposal — confirm keys explicitly before compiling a row diff',
    evidence: {
      column: 'id',
      typeA: 'BIGINT',
      typeB: 'BIGINT',
      rowCountA: 5,
      rowCountB: 5,
      nullCountA: 0,
      nullCountB: 0,
      distinctCountA: 5,
      distinctCountB: 5,
    },
  },
  sampleLimitRequested: 100,
  sampleLimitEffective: 100,
  schemaDrift: [
    {
      kind: 'type-changed-same-family',
      column: 'amount',
      typeA: 'BIGINT',
      typeB: 'DOUBLE',
      familyA: 'numeric',
      familyB: 'numeric',
      nullShareA: null,
      nullShareB: null,
    },
    {
      kind: 'column-removed',
      column: 'legacy',
      typeA: 'VARCHAR',
      typeB: null,
      familyA: 'textual',
      familyB: null,
      nullShareA: null,
      nullShareB: null,
    },
    {
      kind: 'nullability-changed',
      column: 'note',
      typeA: null,
      typeB: null,
      familyA: null,
      familyB: null,
      nullShareA: 0,
      nullShareB: 0.2,
    },
    {
      kind: 'column-added',
      column: 'region',
      typeA: null,
      typeB: 'VARCHAR',
      familyA: null,
      familyB: 'textual',
      nullShareA: null,
      nullShareB: null,
    },
  ],
  columnDeltas: [
    {
      column: 'id',
      typeA: 'BIGINT',
      typeB: 'BIGINT',
      kindA: 'numeric',
      kindB: 'numeric',
      numeric: {
        meanShiftStandardized: 0.505964,
        varianceShiftStandardized: 1.68,
        p50Shift: 0,
        p90Shift: 2,
      },
      categorical: null,
    },
    {
      column: 'name',
      typeA: 'VARCHAR',
      typeB: 'VARCHAR',
      kindA: 'categorical',
      kindB: 'categorical',
      numeric: null,
      categorical: {
        totalVariation: 0.6,
        newCategories: [
          { value: 'a6', count: 1 },
          { value: 'a7', count: 1 },
          { value: 'b2', count: 1 },
        ],
        vanishedCategories: [
          { value: 'a2', count: 1 },
          { value: 'a4', count: 1 },
          { value: 'a5', count: 1 },
        ],
      },
    },
    {
      column: 'amount',
      typeA: 'BIGINT',
      typeB: 'DOUBLE',
      kindA: 'numeric',
      kindB: 'numeric',
      numeric: {
        meanShiftStandardized: 0.613482,
        varianceShiftStandardized: 1.4588,
        p50Shift: 3,
        p90Shift: 20,
      },
      categorical: null,
    },
    {
      column: 'note',
      typeA: 'VARCHAR',
      typeB: 'VARCHAR',
      kindA: 'categorical',
      kindB: 'categorical',
      numeric: null,
      categorical: {
        totalVariation: 0.4,
        newCategories: [{ value: 'n6', count: 1 }],
        vanishedCategories: [
          { value: 'n4', count: 1 },
          { value: 'n5', count: 1 },
        ],
      },
    },
  ],
  rowDiff: {
    rowCountA: 5,
    rowCountB: 5,
    changedComparable: true,
    added: {
      count: 2,
      samplesReturned: 2,
      samplesComplete: true,
      samples: [
        { side: 'B', rowKey: 'b:3' },
        { side: 'B', rowKey: 'b:4' },
      ],
    },
    removed: {
      count: 2,
      samplesReturned: 2,
      samplesComplete: true,
      samples: [
        { side: 'A', rowKey: 'base:3' },
        { side: 'A', rowKey: 'base:4' },
      ],
    },
    changed: {
      count: 2,
      samplesReturned: 2,
      samplesComplete: true,
      samples: [
        { side: 'A', rowKey: 'base:1', changedColumns: ['name', 'amount'] },
        { side: 'A', rowKey: 'base:2', changedColumns: ['amount'] },
      ],
    },
  },
  issues: [],
  identical: false,
} as const

/**
 * The expected envelope for the identical-files leg: everything flat. Schema
 * and deltas are derived from the same A columns; the row diff is 0/0/0.
 */
const EXPECTED_IDENTICAL = {
  report: 'assay-diff-report',
  baseViewOnly: true,
  keys: ['id'],
  keySource: 'inferred',
  inference: {
    columns: ['id'],
    candidateDisclosure:
      "key candidate: column 'id' is unique and non-null on both sides (A: BIGINT, 0 nulls, 5 distinct of 5 rows; B: BIGINT, 0 nulls, 5 distinct of 5 rows)",
    outcomeDisclosure:
      '5 key candidate(s) proposed (single columns the profiles prove non-null and unique on both sides, ranked by profile-A column order); inference is a proposal — confirm keys explicitly before compiling a row diff',
    evidence: {
      column: 'id',
      typeA: 'BIGINT',
      typeB: 'BIGINT',
      rowCountA: 5,
      rowCountB: 5,
      nullCountA: 0,
      nullCountB: 0,
      distinctCountA: 5,
      distinctCountB: 5,
    },
  },
  sampleLimitRequested: 100,
  sampleLimitEffective: 100,
  schemaDrift: [],
  columnDeltas: [
    {
      column: 'id',
      typeA: 'BIGINT',
      typeB: 'BIGINT',
      kindA: 'numeric',
      kindB: 'numeric',
      numeric: {
        meanShiftStandardized: 0,
        varianceShiftStandardized: 0,
        p50Shift: 0,
        p90Shift: 0,
      },
      categorical: null,
    },
    {
      column: 'name',
      typeA: 'VARCHAR',
      typeB: 'VARCHAR',
      kindA: 'categorical',
      kindB: 'categorical',
      numeric: null,
      categorical: { totalVariation: 0, newCategories: [], vanishedCategories: [] },
    },
    {
      column: 'amount',
      typeA: 'BIGINT',
      typeB: 'BIGINT',
      kindA: 'numeric',
      kindB: 'numeric',
      numeric: {
        meanShiftStandardized: 0,
        varianceShiftStandardized: 0,
        p50Shift: 0,
        p90Shift: 0,
      },
      categorical: null,
    },
    {
      column: 'legacy',
      typeA: 'VARCHAR',
      typeB: 'VARCHAR',
      kindA: 'categorical',
      kindB: 'categorical',
      numeric: null,
      categorical: { totalVariation: 0, newCategories: [], vanishedCategories: [] },
    },
    {
      column: 'note',
      typeA: 'VARCHAR',
      typeB: 'VARCHAR',
      kindA: 'categorical',
      kindB: 'categorical',
      numeric: null,
      categorical: { totalVariation: 0, newCategories: [], vanishedCategories: [] },
    },
  ],
  rowDiff: {
    rowCountA: 5,
    rowCountB: 5,
    changedComparable: true,
    added: { count: 0, samplesReturned: 0, samplesComplete: true, samples: [] },
    removed: { count: 0, samplesReturned: 0, samplesComplete: true, samples: [] },
    changed: { count: 0, samplesReturned: 0, samplesComplete: true, samples: [] },
  },
  issues: [],
  identical: true,
} as const

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker
      delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker
    } catch {
      // Non-configurable globals would be a Chromium change; the test then
      // fails loudly at the chooser/download rather than silently.
    }
  })
})

/** Open side A through the real open flow and wait for the grid. */
async function openDatasetA(page: Page, aPath: string, expectedRows = '5'): Promise<void> {
  await page.goto('/')
  await expect(page.getByTestId('open-status')).toHaveText('idle', { timeout: 20_000 })
  const chooser = page.waitForEvent('filechooser')
  await page.getByTestId('open-button').click()
  await (await chooser).setFiles(aPath)
  await expect(page.getByTestId('open-status')).toHaveText('ready', { timeout: 20_000 })
  await expect(page.getByTestId('grid-total-rows')).toHaveText(expectedRows)
}

/** Stage side B through the real comparison control. */
async function stageComparison(page: Page, bPath: string, expectedRows = '5'): Promise<void> {
  const chooser = page.waitForEvent('filechooser')
  await page.getByTestId('diff-open-comparison').click()
  await (await chooser).setFiles(bPath)
  await expect(page.getByTestId('diff-comparison-info')).toBeVisible()
  await expect(page.getByTestId('diff-comparison-rows')).toHaveText(`${expectedRows} rows`)
}

/** Confirm the inferred top candidate (id) and run the row diff. */
async function runInferredDiff(page: Page): Promise<void> {
  await expect(
    page.locator(
      '[data-testid="diff-key-candidate"][data-column="id"] [data-testid="diff-key-candidate-radio"]',
    ),
  ).toBeChecked()
  await page.getByTestId('diff-run').click()
}

/** Export the report through the panel, persist the download, return its path. */
let exportSeq = 0
async function exportReportJson(page: Page): Promise<string> {
  await page.getByTestId('diff-export-format-json').check()
  const downloadPromise = page.waitForEvent('download')
  await page.getByTestId('diff-export-run').click()
  const download: Download = await downloadPromise
  const result = page.getByTestId('diff-export-result')
  await expect(result).toContainText('Exported the diff report (')
  await expect(result).toContainText('new file')
  await expect(result).toContainText('The opened file is unchanged')
  const dir = path.join(tmpdir(), 'assay-m6-5-export')
  mkdirSync(dir, { recursive: true })
  exportSeq += 1
  const target = path.join(dir, `${String(exportSeq)}-${download.suggestedFilename()}`)
  await download.saveAs(target)
  return target
}

/**
 * Spawn the CLI exactly as documented (`node --import tsx src/index.ts` from
 * apps/cli — the m6-3 integration-suite pattern) against the SAME staged
 * paths the browser used.
 */
function runCli(args: readonly string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts', ...args], {
    cwd: CLI_DIR,
    encoding: 'utf8',
  })
  return { exitCode: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** True when the first testid's element precedes the second in the document. */
async function isBefore(page: Page, firstTestId: string, secondTestId: string): Promise<boolean> {
  return page.evaluate(
    ([first, second]) => {
      const a = document.querySelector(`[data-testid="${String(first)}"]`)
      const b = document.querySelector(`[data-testid="${String(second)}"]`)
      if (a === null || b === null) return false
      return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    },
    [firstTestId, secondTestId],
  )
}

/**
 * The surface-neutral slice of an envelope: exactly the two documented
 * surface differences are removed — the CLI's `a`/`b` basenames and the web's
 * `stale` flag. Everything else must be identical.
 */
function comparable(envelope: DiffEnvelope): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...envelope }
  delete copy['a']
  delete copy['b']
  delete copy['stale']
  return copy
}

/**
 * Canonical multiset form of one aspect's samples (side, anchor-free key,
 * sorted changed-column list) — an order-insensitive companion to the
 * ordered assertion, so a tie-order divergence can never mask a set change.
 */
function sampleMultiset(aspect: DiffAspect): string[] {
  return aspect.samples
    .map(
      (sample) =>
        `${sample.side}|${sample.rowKey}|${[...(sample.changedColumns ?? [])].sort().join(',')}`,
    )
    .sort()
}

test('M6 exit journey: same two files agree EXACTLY across web and CLI (schema drift → deltas → row diff)', async ({
  page,
}) => {
  test.setTimeout(300_000)

  const consoleMessages: { type: string; text: string }[] = []
  const pageErrors: string[] = []
  page.on('console', (message) =>
    consoleMessages.push({ type: message.type(), text: message.text() }),
  )
  page.on('pageerror', (error) => pageErrors.push(error.message))

  const pair = writeExitJourneyPair()
  const aName = path.basename(pair.aPath)
  const bName = path.basename(pair.bPath)
  const dir = path.dirname(pair.aPath)

  // ------------------------------------------------------------------
  // WEB: open A, stage B through the real UI controls.
  // ------------------------------------------------------------------
  await openDatasetA(page, pair.aPath)
  await stageComparison(page, pair.bPath)

  // ------------------------------------------------------------------
  // DISCLOSURE ORDER — schema drift before deltas before the key control
  // (the docs-07 honesty rule, made visible end-to-end).
  // ------------------------------------------------------------------
  expect(await isBefore(page, 'diff-schema-drift', 'diff-column-deltas')).toBe(true)
  expect(await isBefore(page, 'diff-column-deltas', 'diff-key-selection')).toBe(true)

  // Every schema-drift finding, pinned to the independent expectation by
  // (column, kind) — neither surface may carry an undeclared finding.
  for (const [column, kind] of [
    ['amount', 'type-changed-same-family'],
    ['legacy', 'column-removed'],
    ['note', 'nullability-changed'],
    ['region', 'column-added'],
  ] as const) {
    await expect(
      page.locator(
        `[data-testid="diff-schema-finding"][data-column="${column}"][data-kind="${kind}"]`,
      ),
    ).toHaveCount(1)
  }
  await expect(page.getByTestId('diff-schema-finding')).toHaveCount(4)
  // The user-visible rendering carries the exact rendered metrics.
  await expect(
    page.locator('[data-testid="diff-schema-finding"][data-column="amount"]'),
  ).toContainText('BIGINT → DOUBLE')
  await expect(
    page.locator('[data-testid="diff-schema-finding"][data-column="note"]'),
  ).toContainText('null share A 0 → B 0.2')

  // Distribution deltas: the four shared columns, in profile-A order, with
  // the exact rendered metrics.
  await expect(page.getByTestId('diff-column-delta')).toHaveCount(4)
  const deltaColumns = await page
    .locator('[data-testid="diff-column-delta"]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-column')))
  expect(deltaColumns).toEqual(['id', 'name', 'amount', 'note'])
  for (const column of ['id', 'name', 'amount', 'note']) {
    await expect(
      page.locator(`[data-testid="diff-column-delta"][data-column="${column}"]`),
    ).toHaveAttribute('data-differs', 'true')
  }
  await expect(page.locator('[data-testid="diff-column-delta"][data-column="id"]')).toContainText(
    'mean shift 0.505964',
  )
  await expect(page.locator('[data-testid="diff-column-delta"][data-column="name"]')).toContainText(
    'total variation 0.6',
  )
  await expect(
    page.locator('[data-testid="diff-column-delta"][data-column="amount"]'),
  ).toContainText('mean shift 0.613482')
  await expect(page.locator('[data-testid="diff-column-delta"][data-column="note"]')).toContainText(
    'total variation 0.4',
  )

  // C2: the inference proposal is rendered verbatim, candidates minimal-first.
  await expect(page.getByTestId('diff-key-outcome')).toHaveText(
    EXPECTED.inference.outcomeDisclosure,
  )
  const candidateIds = await page
    .locator('[data-testid="diff-key-candidate"]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-column')))
  expect(candidateIds).toEqual(['id', 'name', 'amount'])
  await expect(
    page.locator(
      '[data-testid="diff-key-candidate"][data-column="id"] [data-testid="diff-key-candidate-disclosure"]',
    ),
  ).toHaveText(EXPECTED.inference.candidateDisclosure)

  // ------------------------------------------------------------------
  // RUN the confirmed inferred key, then assert the rendered row diff.
  // ------------------------------------------------------------------
  await runInferredDiff(page)
  await expect(page.getByTestId('diff-verdict')).toHaveText(
    '2 added, 2 removed, 2 changed — rows 5 → 5 (keys: id, inferred).',
  )
  // The result renders after the key control (progressive disclosure).
  expect(await isBefore(page, 'diff-key-selection', 'diff-result')).toBe(true)

  const aspect = (name: string) =>
    page.locator(`[data-testid="diff-aspect"][data-aspect="${name}"]`)
  for (const [name, count] of [
    ['added', 2],
    ['removed', 2],
    ['changed', 2],
  ] as const) {
    await expect(aspect(name).getByTestId('diff-aspect-count')).toHaveText(`${name} (${count})`)
  }
  // Added B samples are report-only (C3): no jump affordance.
  await expect(aspect('added').getByTestId('diff-sample')).toHaveCount(2)
  await expect(
    aspect('added').getByTestId('diff-sample').nth(0).getByTestId('diff-sample-key'),
  ).toHaveText('b #3')
  await expect(
    aspect('added').getByTestId('diff-sample').nth(1).getByTestId('diff-sample-key'),
  ).toHaveText('b #4')
  await expect(aspect('added').getByTestId('diff-sample-jump')).toHaveCount(0)
  // Removed/changed samples are A-side with jump affordances.
  await expect(
    aspect('removed').getByTestId('diff-sample').nth(0).getByTestId('diff-sample-key'),
  ).toHaveText('base #3')
  await expect(
    aspect('removed').getByTestId('diff-sample').nth(1).getByTestId('diff-sample-key'),
  ).toHaveText('base #4')
  await expect(
    aspect('changed').getByTestId('diff-sample').nth(0).getByTestId('diff-sample-changed'),
  ).toHaveText('name, amount')
  await expect(
    aspect('changed').getByTestId('diff-sample').nth(1).getByTestId('diff-sample-changed'),
  ).toHaveText('amount')

  // Export the web report (the agreement artifact) — no edits yet, so
  // `stale: false` and `baseViewOnly: true`.
  const webPath = await exportReportJson(page)
  const web = JSON.parse(readFileSync(webPath, 'utf8')) as DiffEnvelope
  expect(web.report).toBe('assay-diff-report')
  expect(web.stale).toBe(false)
  expect(web.baseViewOnly).toBe(true)
  // The web export omits the file names by construction (privacy).
  expect(web.a).toBeUndefined()
  expect(web.b).toBeUndefined()

  // ------------------------------------------------------------------
  // CLI: the SAME two paths, `--infer` (C2), `--sample-limit 100` (K parity).
  // ------------------------------------------------------------------
  const cliArgs = [
    'diff',
    pair.aPath,
    pair.bPath,
    '--infer',
    '--sample-limit',
    '100',
    '--format',
    'json',
  ]
  const cliRun = runCli(cliArgs)
  expect(cliRun.exitCode).toBe(1)
  const cli = JSON.parse(cliRun.stdout) as DiffEnvelope
  expect(cli.report).toBe('assay-diff-report')
  expect(cli.stale).toBeUndefined()

  // The CLI human run pins the aspect order and the exit code.
  const cliHuman = runCli(['diff', pair.aPath, pair.bPath, '--infer', '--sample-limit', '100'])
  expect(cliHuman.exitCode).toBe(1)
  const driftAt = cliHuman.stdout.indexOf('schema drift:')
  const deltasAt = cliHuman.stdout.indexOf('profile deltas:')
  const rowDiffAt = cliHuman.stdout.indexOf('row diff:')
  expect(driftAt).toBeGreaterThan(-1)
  expect(deltasAt).toBeGreaterThan(driftAt)
  expect(rowDiffAt).toBeGreaterThan(deltasAt)
  expect(cliHuman.stdout).toContain('verdict: DIFFERENCES — schema drift, profile deltas, row diff')

  // Second CLI run is byte-identical — the agreement artifact is stable.
  const cliAgain = runCli(cliArgs)
  expect(cliAgain.exitCode).toBe(cliRun.exitCode)
  expect(cliAgain.stdout).toBe(cliRun.stdout)
  expect(cliAgain.stderr).toBe(cliRun.stderr)

  // ------------------------------------------------------------------
  // EXACT CROSS-SURFACE AGREEMENT (triple-pinned).
  // ------------------------------------------------------------------
  // 1. Both surfaces equal the independent expectation field for field…
  expect(comparable(web)).toEqual(EXPECTED)
  expect(comparable(cli)).toEqual(EXPECTED)
  // 2. …and each other (the same statement, stated against each other so a
  //    future surface-specific extraction change cannot silently pass both).
  expect(comparable(cli)).toEqual(comparable(web))

  // Sample SET equality in addition to the ordered deep-equal above, so a
  // tie-order-only divergence cannot mask a set divergence.
  for (const name of ['added', 'removed', 'changed'] as const) {
    expect(sampleMultiset(cli.rowDiff[name]), name).toEqual(sampleMultiset(web.rowDiff[name]))
    expect(sampleMultiset(cli.rowDiff[name]), name).toEqual(
      sampleMultiset(EXPECTED.rowDiff[name] as DiffAspect),
    )
  }

  // Every aspect is complete (≤ K) — the full set IS the LIMIT-selected set.
  for (const name of ['added', 'removed', 'changed'] as const) {
    expect(web.rowDiff[name].samplesComplete, name).toBe(true)
    expect(cli.rowDiff[name].samplesComplete, name).toBe(true)
    expect(web.rowDiff[name].samplesReturned, name).toBe(web.rowDiff[name].count)
    expect(cli.rowDiff[name].samplesReturned, name).toBe(cli.rowDiff[name].count)
  }

  // The CLI's C2 disclosure strings match the web export's verbatim.
  expect(cli.inference).toEqual(web.inference)
  expect(cli.inference).toEqual(EXPECTED.inference)

  // ------------------------------------------------------------------
  // PRIVACY SWEEP (ADR 0025 discipline) — assertions in ONE place.
  // ------------------------------------------------------------------
  // 1. Neither file name (nor the temp directory) is rendered on the page.
  const bodyText = (await page.locator('main').textContent()) ?? ''
  expect(bodyText).not.toContain(aName)
  expect(bodyText).not.toContain(bName)
  expect(bodyText).not.toContain(dir)

  // 2. The web export carries no file paths/names and no anchor fingerprint.
  const webText = readFileSync(webPath, 'utf8')
  expect(webText).not.toContain(aName)
  expect(webText).not.toContain(bName)
  expect(webText).not.toContain(dir)
  expect(webText).not.toContain('anchor')

  // 3. The CLI JSON names the dataset by BASENAME only (the documented
  //    byte-stable envelope) and never carries the temp directory.
  expect(cli.a).toEqual({ name: aName, format: 'jsonl' })
  expect(cli.b).toEqual({ name: bName, format: 'jsonl' })
  expect(cliRun.stdout).not.toContain(dir)
  expect(cliHuman.stdout).toContain(`a: ${aName} (jsonl)`)
  expect(cliHuman.stdout).toContain(`b: ${bName} (jsonl)`)
  expect(cliHuman.stdout).not.toContain(dir)

  // 4. No dataset value (or file name) reached any console message, and the
  //    app produced no console/page output at all (there are no logs by
  //    design — no new telemetry or console surface).
  expect(pageErrors).toEqual([])
  expect(consoleMessages).toEqual([])

  // 5. Every happy-path CLI run kept stderr completely empty (no values, no
  //    paths — the value-free stderr contract).
  expect(cliRun.stderr).toBe('')
  expect(cliAgain.stderr).toBe('')
  expect(cliHuman.stderr).toBe('')
})

test('M6 exit journey zero-state: identical files agree EXACTLY (identical: true, exit 0)', async ({
  page,
}) => {
  test.setTimeout(300_000)

  const pair = writeExitJourneyIdenticalPair()
  const aName = path.basename(pair.aPath)
  const bName = path.basename(pair.bPath)
  const dir = path.dirname(pair.aPath)

  await openDatasetA(page, pair.aPath)
  await stageComparison(page, pair.bPath)

  // Schema drift is explicitly none; the five shared columns' deltas are flat.
  await expect(page.getByTestId('diff-schema-drift-none')).toBeVisible()
  await expect(page.getByTestId('diff-column-delta')).toHaveCount(5)
  for (const delta of await page.getByTestId('diff-column-delta').all()) {
    await expect(delta).toHaveAttribute('data-differs', 'false')
  }

  await runInferredDiff(page)
  const verdict = page.getByTestId('diff-verdict')
  await expect(verdict).toContainText('No differences')
  await expect(verdict).toContainText('row-level comparison (keys: id)')
  await expect(verdict).toContainText('every aspect that ran')
  for (const name of ['added', 'removed', 'changed'] as const) {
    await expect(aspectCount(page, name)).toHaveText(`${name} (0)`)
  }

  const webPath = await exportReportJson(page)
  const web = JSON.parse(readFileSync(webPath, 'utf8')) as DiffEnvelope
  expect(web.stale).toBe(false)
  expect(web.schemaDrift).toEqual([])
  expect(web.columnDeltas).toHaveLength(5)
  expect(comparable(web)).toEqual(EXPECTED_IDENTICAL)

  const cliRun = runCli([
    'diff',
    pair.aPath,
    pair.bPath,
    '--infer',
    '--sample-limit',
    '100',
    '--format',
    'json',
  ])
  expect(cliRun.exitCode).toBe(0)
  expect(cliRun.stderr).toBe('')
  const cli = JSON.parse(cliRun.stdout) as DiffEnvelope
  expect(cli.identical).toBe(true)
  expect(comparable(cli)).toEqual(EXPECTED_IDENTICAL)
  expect(comparable(cli)).toEqual(comparable(web))

  // Privacy, same sweep as the main leg.
  const bodyText = (await page.locator('main').textContent()) ?? ''
  expect(bodyText).not.toContain(aName)
  expect(bodyText).not.toContain(bName)
  expect(bodyText).not.toContain(dir)
  const webText = readFileSync(webPath, 'utf8')
  expect(webText).not.toContain(aName)
  expect(webText).not.toContain(bName)
  expect(webText).not.toContain(dir)
  expect(cliRun.stdout).not.toContain(dir)
})

/** The per-aspect count locator for the zero-state leg. */
function aspectCount(page: Page, name: string) {
  return page.locator(
    `[data-testid="diff-aspect"][data-aspect="${name}"] [data-testid="diff-aspect-count"]`,
  )
}

test('M6 exit journey >K selection: both surfaces select the SAME 100 of 120 added rows', async ({
  page,
}) => {
  test.setTimeout(300_000)

  const pair = writeExitJourneyOverKPair()
  const aName = path.basename(pair.aPath)
  const bName = path.basename(pair.bPath)
  const dir = path.dirname(pair.aPath)

  await openDatasetA(page, pair.aPath, '1')
  await stageComparison(page, pair.bPath, '121')
  await runInferredDiff(page)
  await expect(page.getByTestId('diff-verdict')).toHaveText(
    '120 added, 0 removed, 0 changed — rows 1 → 121 (keys: id, inferred).',
  )

  const webPath = await exportReportJson(page)
  const web = JSON.parse(readFileSync(webPath, 'utf8')) as DiffEnvelope
  expect(web.stale).toBe(false)

  const cliRun = runCli([
    'diff',
    pair.aPath,
    pair.bPath,
    '--infer',
    '--sample-limit',
    '100',
    '--format',
    'json',
  ])
  expect(cliRun.exitCode).toBe(1)
  expect(cliRun.stderr).toBe('')
  const cli = JSON.parse(cliRun.stdout) as DiffEnvelope

  // The plan's LIMIT selection is partial on BOTH surfaces — explicitly:
  // count 120, 100 returned, incomplete — and BOTH selected the same 100
  // rows `b:1`..`b:100` (the m6-2 >K carry-over pinned). The CLI human
  // output discloses the clamp.
  const selectedKeys = Array.from({ length: 100 }, (_, index) => `b:${String(index + 1)}`)
  for (const [label, envelope] of [
    ['web', web],
    ['cli', cli],
  ] as const) {
    expect(envelope.rowDiff.added.count, label).toBe(120)
    expect(envelope.rowDiff.added.samplesReturned, label).toBe(100)
    expect(envelope.rowDiff.added.samplesComplete, label).toBe(false)
    expect(
      envelope.rowDiff.added.samples.map((sample) => sample.rowKey),
      label,
    ).toEqual(selectedKeys)
    expect(envelope.sampleLimitRequested, label).toBe(100)
    expect(envelope.sampleLimitEffective, label).toBe(100)
  }
  // The rest of the envelope agrees surface-to-surface too (deltas, issues,
  // keys, inference) — only the two documented surface fields differ.
  expect(comparable(cli)).toEqual(comparable(web))
  const cliHuman = runCli(['diff', pair.aPath, pair.bPath, '--infer', '--sample-limit', '100'])
  expect(cliHuman.stdout).toContain('… 20 more added rows not shown (sample limit 100)')

  // Privacy (basename-only CLI; no names on the page or in the web export).
  expect(cliRun.stdout).not.toContain(dir)
  const bodyText = (await page.locator('main').textContent()) ?? ''
  expect(bodyText).not.toContain(aName)
  expect(bodyText).not.toContain(bName)
  expect(readFileSync(webPath, 'utf8')).not.toContain(dir)
})
