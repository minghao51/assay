import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Download, Locator, Page } from '@playwright/test'
import { writeValidationDatasetA } from './support/validation-datasets'

// Task m5-6 (handoff §6) — the M5 EXIT JOURNEY: the two validation surfaces
// must agree EXACTLY on the same inputs, then the fix-to-clean loop must
// close, with a real privacy sweep and no honesty gaps.
//
// "Same contract + same dirty file" is literally true here: ONE dataset file
// and ONE contract YAML are staged into a fresh temp dir (runtime-built,
// deterministic, never committed — the m5-2/m5-3 on-demand pattern), the
// browser opens BOTH through the real UI controls (dataset via the open
// flow, contract via the panel's import control), and the CLI process is
// spawned (node --import tsx) against the SAME two paths.
//
// The agreement is asserted, not sampled: the per-rule web report is
// extracted via the JSON report export (download → read from disk), the
// per-rule CLI report via `assay validate --format json`, and then EVERY
// rule of the contract (all 9 — the full set, listed explicitly below) is
// compared: identical ruleId set (as the identical severity sequence), the
// identical failCount, the identical frozen integer failPercent, the
// identical samplesReturned/samplesComplete, the identical total verdict,
// the identical datasetRows, and sample (rowKey, value) pairs compared as
// MULTISETS.
//
// ## Why multisets (the documented normalization)
//
// Both surfaces execute BYTE-IDENTICAL plan SQL (the m5-1/m5-2 discipline),
// but on DIFFERENT DuckDB engines: the web runs DuckDB-WASM 1.32-era while
// the CLI runs native 1.5.5 (@duckdb/node-api, ADR 0041). Engines may return
// tied rows (equal ORDER BY-less violating rows) in different orders. The
// frozen report contract covers counts and the violation SET — never sample
// ORDER — so pairs are compared order-insensitively, tagged with the value's
// JSON type so cross-type collisions cannot mask a mismatch (1 ≠ '1',
// null ≠ 'null'). Values themselves must agree exactly as sets.
//
// Clamped (partial) sample sets would add a second engine-order hazard: two
// engines may return DIFFERENT 100-row subsets of a larger violation set.
// This journey deliberately uses the 7-row dataset A, where every rule's
// sample set is COMPLETE (failCount ≤ samples returned ≤ 100), so the
// multiset assertion is exact; the partial-set honesty (disabled filter,
// specific copy, clamp disclosure) is pinned per-surface by the m5-3 export
// journey and the m5-4 CLI integration suite and is out of the frozen
// cross-surface contract by design.
//
// The fix-all leg: every violation is fixed through the REAL M4 editing UI,
// reached via the sample list's jump-to-row channel; the verdict goes stale
// after the edits (exported as stale: true), re-validation flips it to
// "Valid: 0 violations across 9 rules", and the fresh export says
// stale: false. The CLI is deliberately NOT involved post-edit (base-view-
// only honesty — a CLI re-run would still see the raw file): only the
// panel's post-fix verdict is asserted.
//
// Privacy sweep (ADR 0025) — assertions, not hopes — kept in ONE place (the
// final section): the contract text contains no file name by construction;
// the panel never renders the dataset's or the contract's file name; the
// exported reports (web JSON, CLI JSON) contain no file paths or file names;
// the CLI's human report names the dataset by BASENAME only (the documented
// discipline) and never carries the directory; stderr on both CLI runs is
// completely empty (no values, no paths).
//
// Picker path (m1-5/m4-5 pattern): init scripts remove the FSA globals so
// opens ride the hidden-input fallback (filechooser events) and exports ride
// the anchor-download fallback (download events).

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const CLI_DIR = path.join(REPO_ROOT, 'apps/cli')

/** Every rule the staged contract declares — the FULL set (agreement is not sampled). */
const ALL_RULE_IDS = [
  'columns[0].type',
  'columns[0].required',
  'columns[0].unique',
  'columns[1].type',
  'columns[1].required',
  'columns[1].allowed-values',
  'columns[2].type',
  'columns[2].max',
  'dataset.min-rows',
] as const

/**
 * The documented severity order for this contract — the four clauses of
 * report-model.ts / apps/cli/src/report.ts applied to the CLI-derived
 * counts in support/validation-datasets.ts: (1) failing before passing;
 * (2) dataset-fact rules before row-samples rules within each group (the
 * declared-type facts and min-rows lead the passing tail); (3) higher
 * frozen failPercent first; (4) ruleId ascending as the total tiebreak.
 */
const EXPECTED_SEVERITY_ORDER = [
  'columns[0].unique',
  'columns[0].required',
  'columns[1].allowed-values',
  'columns[2].max',
  'columns[0].type',
  'columns[1].type',
  'columns[2].type',
  'dataset.min-rows',
  'columns[1].required',
] as const

/**
 * The CLI-derived expected shape of every rule over dataset A (see
 * support/validation-datasets.ts): failCount / frozen half-up failPercent /
 * the (rowKey, value) sample pairs. 'base:<n>' keys are the anchor-free
 * export grammar shared by both surfaces.
 */
const EXPECTED_RULES: Readonly<
  Record<
    (typeof ALL_RULE_IDS)[number],
    {
      failCount: number
      failPercent: number
      samples: readonly (readonly [string, string | number | boolean | null])[]
    }
  >
> = {
  'columns[0].unique': {
    failCount: 2,
    failPercent: 29,
    samples: [
      ['base:0', 1001],
      ['base:5', 1001],
    ],
  },
  'columns[0].required': { failCount: 1, failPercent: 14, samples: [['base:6', null]] },
  'columns[1].allowed-values': { failCount: 1, failPercent: 14, samples: [['base:2', 'emea']] },
  'columns[2].max': { failCount: 1, failPercent: 14, samples: [['base:1', 999]] },
  'columns[0].type': { failCount: 0, failPercent: 0, samples: [] },
  'columns[1].type': { failCount: 0, failPercent: 0, samples: [] },
  'columns[2].type': { failCount: 0, failPercent: 0, samples: [] },
  'dataset.min-rows': { failCount: 0, failPercent: 0, samples: [] },
  'columns[1].required': { failCount: 0, failPercent: 0, samples: [] },
}

/** One per-rule entry as BOTH surfaces' JSON exports carry it. */
interface ReportRule {
  readonly ruleId: string
  readonly failCount: number
  readonly failPercent: number
  readonly samplesReturned: number
  readonly samplesComplete: boolean
  readonly sampleRowKeys: readonly string[]
  readonly sampleValues: readonly (string | number | boolean | null)[]
}

/** The shared report-envelope shape (web report export ≡ CLI --format json). */
interface ReportEnvelope {
  readonly report: string
  readonly baseViewOnly?: boolean
  readonly contract: { readonly name: string; readonly version: number }
  readonly valid: boolean
  readonly stale: boolean
  readonly datasetRows: number
  readonly rules: readonly ReportRule[]
}

/**
 * Canonical type-tagged form of one sample value for multiset comparison —
 * the documented normalization (see the module comment). The tag carries the
 * JSON type so a string '999' can never pass for the number 999 and null can
 * never pass for 'null'.
 */
function valueTag(value: string | number | boolean | null): string {
  if (value === null) return 'null:'
  if (typeof value === 'string') return `s:${value}`
  if (typeof value === 'boolean') return `b:${value ? 'true' : 'false'}`
  return `n:${String(value)}`
}

/** Multiset (order-insensitive) form of a rule's sample values. */
function valueMultiset(rule: ReportRule): string[] {
  return rule.sampleValues.map(valueTag).sort()
}

/**
 * Multiset form of a rule's (rowKey, value) PAIRS — values and the rows they
 * sit in must agree together, order-insensitively.
 */
function pairMultiset(rule: ReportRule): string[] {
  return rule.sampleValues
    .map((value, index) => `${rule.sampleRowKeys[index] ?? '?'}=${valueTag(value)}`)
    .sort()
}

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

function ruleRow(page: Page, ruleId: string): Locator {
  return page.locator(`[data-testid="validation-rule"][data-rule-id="${ruleId}"]`)
}

/** Export through the panel, persist the download, return its path. */
let exportSeq = 0
async function exportReportJson(page: Page, tag: string): Promise<string> {
  await page.getByTestId('validation-export-format-json').check()
  const downloadPromise = page.waitForEvent('download')
  await page.getByTestId('validation-export-run').click()
  const download: Download = await downloadPromise
  const result = page.getByTestId('validation-export-result')
  await expect(result).toContainText('Exported the failure report (9 rules)')
  await expect(result).toContainText('new file')
  await expect(result).toContainText('The opened file is unchanged')
  const dir = path.join(tmpdir(), 'assay-m5-6-journey')
  mkdirSync(dir, { recursive: true })
  exportSeq += 1
  const target = path.join(dir, `${tag}-${String(exportSeq)}-${download.suggestedFilename()}`)
  await download.saveAs(target)
  return target
}

/**
 * Edit one cell through the real M4 inline editor (the row is located by
 * effective index — base rows without deletes/inserts keep their ordinals).
 * `initialValue` proves the editor opened on the OFFENDING cell with the
 * offending value (NULL opens empty) before the fix is typed.
 */
async function editCell(
  page: Page,
  rowIndex: number,
  cellIndex: number,
  initialValue: string,
  value: string,
): Promise<void> {
  const row = page.locator(`[data-testid="grid-row"][data-row-index="${String(rowIndex)}"]`)
  await row.scrollIntoViewIfNeeded()
  await expect(row).toHaveAttribute('data-status', 'ready')
  await row.getByTestId('grid-cell').nth(cellIndex).dblclick()
  const editor = page.getByTestId('grid-editor-input')
  await expect(editor).toHaveValue(initialValue)
  await editor.fill(value)
  await editor.press('Enter')
  await expect(page.getByTestId('grid-cell-editor')).toHaveCount(0)
}

/**
 * Jump to a failing sample via the sample list's jump-to-row channel. The
 * sample is located by its anchor-free display key, matched as a WHOLE word
 * (not by list index — the engine's sample order is not part of the frozen
 * contract), and the jump must land the target row ready and in view.
 */
async function jumpToSample(
  page: Page,
  ruleId: string,
  displayKey: string,
  rowIndex: number,
): Promise<void> {
  await ruleRow(page, ruleId)
    .getByTestId('validation-sample')
    .filter({ hasText: new RegExp(`(^|\\s)${displayKey}(\\s|$)`) })
    .getByTestId('validation-sample-jump')
    .click()
  const row = page.locator(`[data-testid="grid-row"][data-row-index="${String(rowIndex)}"]`)
  await expect(row).toHaveAttribute('data-status', 'ready')
  await expect(row).toBeInViewport()
}

/**
 * Spawn the CLI exactly as documented (`node --import tsx src/index.ts` from
 * apps/cli — the m5-4 integration-suite pattern) against the SAME staged
 * paths the browser is using.
 */
function runCli(args: readonly string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts', ...args], {
    cwd: CLI_DIR,
    encoding: 'utf8',
  })
  return { exitCode: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

test('M5 exit journey: same contract + same dirty file agree EXACTLY across web and CLI, then fix-all → clean', async ({
  page,
}) => {
  test.setTimeout(300_000)

  // ------------------------------------------------------------------
  // Stage: ONE dataset file + ONE contract YAML in a fresh temp dir.
  // Both surfaces consume exactly these two paths.
  // ------------------------------------------------------------------
  const dataset = writeValidationDatasetA()
  const dataName = path.basename(dataset.dataPath)
  const contractName = path.basename(dataset.contractPath)
  const dataDir = path.dirname(dataset.dataPath)

  // --- WEB: open the dataset through the real open flow. ---
  await page.goto('/')
  await expect(page.getByTestId('open-status')).toHaveText('idle')
  let chooserPromise = page.waitForEvent('filechooser')
  await page.getByTestId('open-button').click()
  await (await chooserPromise).setFiles(dataset.dataPath)
  await expect(page.getByTestId('open-status')).toHaveText('ready')
  await expect(page.getByTestId('grid-total-rows')).toHaveText('7')

  // --- WEB: import the contract through the panel's import control. ---
  chooserPromise = page.waitForEvent('filechooser')
  await page.getByTestId('validation-open-contract').click()
  await (await chooserPromise).setFiles(dataset.contractPath)
  await expect(page.getByTestId('validation-contract-name')).toHaveText('orders-basic')
  await expect(page.getByTestId('validation-contract-info')).toContainText('9 rules')

  // --- WEB: validate → the verdict and the failing set on screen. ---
  await page.getByTestId('validation-run').click()
  await expect(page.getByTestId('validation-verdict')).toHaveText(
    '4 of 9 rules fail (7 rows checked).',
  )
  await expect(page.getByTestId('validation-stale')).toHaveCount(0)
  expect(await ruleRow(page, 'columns[0].unique').getAttribute('data-failing')).toBe('true')
  expect(await ruleRow(page, 'dataset.min-rows').getAttribute('data-failing')).toBe('false')

  // --- WEB: export the PRE-fix failure report (the agreement artifact). ---
  const webPreFixPath = await exportReportJson(page, 'web-prefix')
  const webPreFix = JSON.parse(readFileSync(webPreFixPath, 'utf8')) as ReportEnvelope
  expect(webPreFix.report).toBe('assay-validation-report')
  expect(webPreFix.contract).toEqual({ name: 'orders-basic', version: 1 })
  expect(webPreFix.valid).toBe(false)
  expect(webPreFix.stale).toBe(false)
  expect(webPreFix.datasetRows).toBe(7)

  // ------------------------------------------------------------------
  // CLI: the SAME two paths, the real spawned process. The JSON run is
  // the agreement artifact; the human run pins exit code + verdict line.
  // The web panel compiled its plan with K=100; pass the same K so
  // samplesReturned is comparable rule for rule.
  // ------------------------------------------------------------------
  const cliJson = runCli([
    'validate',
    dataset.dataPath,
    '--contract',
    dataset.contractPath,
    '--format',
    'json',
    '--sample-limit',
    '100',
  ])
  expect(cliJson.exitCode).toBe(1)
  const cli = JSON.parse(cliJson.stdout) as ReportEnvelope
  expect(cli.report).toBe('assay-validation-report')

  const cliHuman = runCli(['validate', dataset.dataPath, '--contract', dataset.contractPath])
  expect(cliHuman.exitCode).toBe(1)
  expect(cliHuman.stdout).toContain('verdict: INVALID — 4 of 9 rules failing (7 rows)')
  // The human report's numbers agree with the JSON's, rule for rule.
  for (const ruleId of ALL_RULE_IDS) {
    const expected = EXPECTED_RULES[ruleId]
    if (expected.failCount > 0) {
      expect(cliHuman.stdout).toContain(`FAIL ${ruleId}`)
      expect(cliHuman.stdout).toContain(
        `${String(expected.failCount)} of 7 rows (${String(expected.failPercent)}%)`,
      )
    }
  }

  // Two CLI runs are byte-identical — the agreement artifact is stable.
  const cliAgain = runCli([
    'validate',
    dataset.dataPath,
    '--contract',
    dataset.contractPath,
    '--format',
    'json',
    '--sample-limit',
    '100',
  ])
  expect(cliAgain.stdout).toBe(cliJson.stdout)
  expect(cliAgain.exitCode).toBe(cliJson.exitCode)

  // ------------------------------------------------------------------
  // EXACT AGREEMENT — asserted, not sampled, for EVERY rule of the
  // contract (all 9 listed in ALL_RULE_IDS; neither side may carry a
  // rule the contract does not declare).
  // ------------------------------------------------------------------
  expect(webPreFix.rules.map((rule) => rule.ruleId)).toEqual([...EXPECTED_SEVERITY_ORDER])
  expect(cli.rules.map((rule) => rule.ruleId)).toEqual([...EXPECTED_SEVERITY_ORDER])

  expect(cli.baseViewOnly).toBe(true)
  expect(cli.stale).toBe(false)
  expect(cli.contract).toEqual(webPreFix.contract)

  // Verdict level: identical total verdict and identical datasetRows.
  expect(cli.valid).toBe(webPreFix.valid)
  expect(cli.valid).toBe(false)
  expect(cli.datasetRows).toBe(webPreFix.datasetRows)
  expect(cli.datasetRows).toBe(7)

  for (const ruleId of ALL_RULE_IDS) {
    const expected = EXPECTED_RULES[ruleId]
    const webRule = webPreFix.rules.find((rule) => rule.ruleId === ruleId)
    const cliRule = cli.rules.find((rule) => rule.ruleId === ruleId)
    expect(webRule, ruleId).toBeDefined()
    expect(cliRule, ruleId).toBeDefined()
    if (webRule === undefined || cliRule === undefined) continue

    // Identical counts: failCount, frozen failPercent, sample bookkeeping.
    expect(webRule.failCount, ruleId).toBe(cliRule.failCount)
    expect(webRule.failPercent, ruleId).toBe(cliRule.failPercent)
    expect(webRule.samplesReturned, ruleId).toBe(cliRule.samplesReturned)
    expect(webRule.samplesComplete, ruleId).toBe(cliRule.samplesComplete)

    // …and both agree with the CLI-derived expectation (triple agreement).
    expect(cliRule.failCount, ruleId).toBe(expected.failCount)
    expect(cliRule.failPercent, ruleId).toBe(expected.failPercent)
    expect(cliRule.samplesReturned, ruleId).toBe(expected.samples.length)
    expect(cliRule.samplesComplete, ruleId).toBe(true)

    // Sample VALUES as multisets (documented normalization: tied rows may
    // return in different orders on the two engines; the value SET is the
    // contract), and the (rowKey, value) PAIRS as multisets too.
    expect(valueMultiset(webRule), ruleId).toEqual(valueMultiset(cliRule))
    expect(valueMultiset(cliRule), ruleId).toEqual(
      expected.samples.map(([, value]) => valueTag(value)).sort(),
    )
    expect(pairMultiset(webRule), ruleId).toEqual(pairMultiset(cliRule))
    expect(pairMultiset(cliRule), ruleId).toEqual(
      expected.samples.map(([key, value]) => `${key}=${valueTag(value)}`).sort(),
    )
  }

  // ------------------------------------------------------------------
  // FIX-ALL: every violation fixed through the REAL M4 editing UI,
  // each reached via the sample list's jump-to-row channel. The samples
  // are located by their anchor-free display key (NOT by index — the
  // engine's sample order is not part of the frozen contract).
  // ------------------------------------------------------------------
  // columns[0].unique: base #5 carries the duplicate 1001 → 1006.
  await jumpToSample(page, 'columns[0].unique', 'base #5', 5)
  await editCell(page, 5, 0, '1001', '1006')
  // columns[0].required: base #6 is the NULL order_id → 1009.
  await jumpToSample(page, 'columns[0].required', 'base #6', 6)
  await editCell(page, 6, 0, '', '1009')
  // columns[1].allowed-values: base #2 is 'emea' → 'EMEA'.
  await jumpToSample(page, 'columns[1].allowed-values', 'base #2', 2)
  await editCell(page, 2, 1, 'emea', 'EMEA')
  // columns[2].max: base #1 is 999 → 450.
  await jumpToSample(page, 'columns[2].max', 'base #1', 1)
  await editCell(page, 1, 2, '999', '450')

  // Every edit staled the verdict; the stale report stays viewable.
  await expect(page.getByTestId('validation-stale')).toBeVisible()
  await expect(page.getByTestId('validation-stale')).toContainText('stale')
  await expect(page.getByTestId('validation-verdict')).toHaveText(
    '4 of 9 rules fail (7 rows checked).',
  )

  // STALE-EXPORT HONESTY: the post-edit export reflects the screen — the
  // same (pre-fix) numbers, flagged stale.
  const webStalePath = await exportReportJson(page, 'web-stale')
  const webStale = JSON.parse(readFileSync(webStalePath, 'utf8')) as ReportEnvelope
  expect(webStale.stale).toBe(true)
  expect(webStale.valid).toBe(false)
  expect(webStale.datasetRows).toBe(7)
  // The stale export is the PRE-fix report verbatim — same rules, same
  // counts — with only the staleness flag flipped.
  expect(webStale.rules).toEqual(webPreFix.rules)

  // --- RE-VALIDATE → CLEAN (the journey's done-when). ---
  await page.getByTestId('validation-run').click()
  await expect(page.getByTestId('validation-verdict')).toHaveText(
    'Valid: 0 violations across 9 rules (7 rows checked).',
  )
  await expect(page.getByTestId('validation-stale')).toHaveCount(0)
  for (const rule of await page.locator('[data-testid="validation-rule"]').all()) {
    await expect(rule).toHaveAttribute('data-failing', 'false')
  }

  // FRESH-EXPORT HONESTY: the post-fix export is valid and fresh.
  const webCleanPath = await exportReportJson(page, 'web-clean')
  const webClean = JSON.parse(readFileSync(webCleanPath, 'utf8')) as ReportEnvelope
  expect(webClean.stale).toBe(false)
  expect(webClean.valid).toBe(true)
  expect(webClean.datasetRows).toBe(7)
  for (const rule of webClean.rules) {
    expect(rule.failCount, rule.ruleId).toBe(0)
    expect(rule.failPercent, rule.ruleId).toBe(0)
    expect(rule.sampleValues, rule.ruleId).toEqual([])
  }
  // The CLI is deliberately NOT involved post-edit: it validates the raw
  // base file (baseViewOnly) and its verdict CANNOT see the edits — the
  // panel's post-fix verdict is the only honest post-edit assertion.

  // ------------------------------------------------------------------
  // PRIVACY SWEEP (ADR 0025) — assertions, not hopes, in ONE place.
  // ------------------------------------------------------------------
  // 1. The contract text contains no file name BY CONSTRUCTION.
  const contractText = readFileSync(dataset.contractPath, 'utf8')
  expect(contractText).not.toContain(dataName)
  expect(contractText).not.toContain(dataDir)

  // 2. The panel never renders the dataset's or the contract's file name
  //    (the contract's metadata NAME 'orders-basic' is content and may show).
  const bodyText = (await page.locator('main').textContent()) ?? ''
  expect(bodyText).not.toContain(dataName)
  expect(bodyText).not.toContain(contractName)
  expect(bodyText).not.toContain(dataDir)

  // 3. The exported reports carry no file paths or file names.
  for (const reportPath of [webPreFixPath, webStalePath, webCleanPath]) {
    const text = readFileSync(reportPath, 'utf8')
    expect(text).not.toContain(dataDir)
    expect(text).not.toContain(dataName)
    expect(text).not.toContain(contractName)
    expect(text).not.toContain('fv-') // the anchor fingerprint never leaves the app
  }
  expect(cliJson.stdout).not.toContain(dataDir)
  expect(cliJson.stdout).not.toContain(dataName)
  expect(cliJson.stdout).not.toContain(contractName)

  // 4. The CLI's human report names the dataset by BASENAME only (the
  //    documented discipline) and never carries the directory.
  expect(cliHuman.stdout).toContain(`dataset: ${dataName}`)
  expect(cliHuman.stdout).not.toContain(dataDir)

  // 5. No values and no paths in stderr on ANY CLI run — success output
  //    keeps stderr completely empty.
  expect(cliJson.stderr).toBe('')
  expect(cliAgain.stderr).toBe('')
  expect(cliHuman.stderr).toBe('')
})
