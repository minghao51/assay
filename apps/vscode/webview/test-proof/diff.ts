// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Confirmed-key diff proof orchestration (D03b) — drives the REAL diff panel
 * controls: refusal before staging, refusal without confirmed keys, a baseline
 * confirmed run with exact counts, A-side navigation, the four agreement
 * fixture classes, the stale flip after an accepted edit, the edited re-diff
 * (baseViewOnly false) and the report/copy exports the CLI agreement leg reads.
 *
 * TEST-PROOF code: reached only through `webview/test-proof/index.ts`, which
 * the entry calls only when `config.testHarness` is set (host:
 * `ExtensionMode.Test`).
 */
import type { RowId } from '@assay/domain'
import { isDiffStale } from '../../src/pure/diff-controller'
import type { DiffReportView } from '../../src/pure/diff-controller'
import type { EditController } from '../../src/pure/edit-controller'
import type { WebviewDataGrid } from '../data-grid'
import type { DiffPanel } from '../diff-panel'
import { elementOrThrow } from '../dom'
import type { EngineGridProvider } from '../grid-provider'
import { waitUntil } from './harness'

/** The `diffProof` payload of the `opened` message. */
export interface StagedDiffProofResult {
  readonly unconfirmedRefused: boolean
  readonly staleAfterEdit: boolean
  readonly baseViewOnlyFalse: boolean
  readonly navigation: boolean
  readonly baselineCounts: readonly [number, number, number]
  readonly editedChangedCount: number
  readonly identicalCase: boolean
  readonly schemaOnlyCase: boolean
  readonly noComparableCase: boolean
  readonly nestedCase: boolean
}

/** The `diffCommandProof` payload (the compare-command opened panel). */
export interface CommandDiffProofResult {
  readonly staged: boolean
  readonly unconfirmedRefused: boolean
  readonly baselineCounts: readonly [number, number, number]
}

/** Explicit inputs shared by both diff proofs. */
export interface DiffProofInput {
  readonly diff: DiffPanel
  readonly controller: EditController
  readonly provider: EngineGridProvider
  readonly grid: WebviewDataGrid
  readonly setStage: (stage: string) => void
}

const READY_STATUS = 'Comparison ready. Choose keys and confirm to run.'

export async function exerciseStagedDiff(
  input: DiffProofInput & { readonly exportEffectiveCopy: () => Promise<void> },
): Promise<StagedDiffProofResult> {
  const { diff, controller, provider, grid, setStage, exportEffectiveCopy } = input
  const status = (): string => elementOrThrow('diff-status').textContent ?? ''
  const report = (): DiffReportView | null => diff.publishedReport
  const busy = (): boolean => diff.running
  // The editor harness that ran first leaves net-neutral ops (insert/delete
  // pairs) in the session; a base-view baseline diff needs the pristine
  // overlay, so undo to the session's base state before proving anything.
  setStage('diff-reset-overlay')
  while (controller.snapshot.history.cursor > 0) await controller.undo()
  // Refusal before any staging: the confirm button cannot run anything while
  // no comparison is staged (the gate is explicit confirmation, not selection).
  setStage('diff-unconfirmed-refusal')
  if (!elementOrThrow('diff-confirm').hasAttribute('disabled'))
    throw new Error('diff confirm is enabled before a comparison is staged')
  elementOrThrow('diff-confirm').dispatchEvent(new Event('click'))
  if (!status().startsWith('Diff refused'))
    throw new Error('unconfirmed diff execution was not refused before staging')
  // Refusal after staging with no keys selected (the multi-select starts empty).
  setStage('diff-comparison-select')
  elementOrThrow('comparison-select').dispatchEvent(new Event('click'))
  await waitUntil(() => diff.comparisonIsStaged || status().includes('not be staged'))
  if (!diff.comparisonIsStaged) throw new Error('staged-diff comparison staging failed')
  setStage('diff-unconfirmed-keys')
  elementOrThrow('diff-confirm').dispatchEvent(new Event('click'))
  if (!status().startsWith('Diff refused: invalid keys'))
    throw new Error('diff ran (or was refused for the wrong reason) without confirmed keys')
  const unconfirmedRefused = true
  // Baseline: confirm the fixture key explicitly and wait for the report.
  setStage('diff-baseline')
  const select = elementOrThrow('diff-keys') as HTMLSelectElement
  for (const option of [...select.options]) option.selected = option.value === 'id'
  elementOrThrow('diff-confirm').dispatchEvent(new Event('click'))
  try {
    await waitUntil(
      () => report() !== null && !busy() && report()?.revision === controller.snapshot.revision,
    )
  } catch (error) {
    throw new Error(
      `staged-diff baseline wait failed (status=${status().slice(0, 140)}): ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const baseline = report()
  if (baseline === null) throw new Error('confirmed diff did not publish a report')
  const baselineCounts = baseline.aspects.map((aspect) => aspect.count) as [number, number, number]
  if (
    baselineCounts[0] !== 1 ||
    baselineCounts[1] !== 1 ||
    baselineCounts[2] !== 1 ||
    baseline.identical ||
    !baseline.baseViewOnly
  ) {
    throw new Error(
      `staged-diff baseline counts/verdict invariant failed: counts=${baselineCounts.join('/')} identical=${String(baseline.identical)} baseViewOnly=${String(baseline.baseViewOnly)}`,
    )
  }
  // Navigation: an A-side changed sample must resolve to a live grid row.
  setStage('diff-navigation')
  const changed = baseline.aspects[2]
  const sample = changed.samples.find((entry) => entry.side === 'A')
  if (sample === undefined) throw new Error('staged-diff changed aspect has no A-side sample')
  let navigation = false
  const total = await provider.rowCount()
  for (let start = 0; start < total; start += 128) {
    const page = await provider.fetchRange({
      startRow: start,
      endRow: Math.min(total, start + 128),
      startCol: 0,
      endCol: (await provider.schema()).length,
    })
    const offset = (page.rowKeys ?? []).indexOf(sample.rowKey)
    if (offset >= 0) {
      grid.scrollToRow(start + offset)
      navigation = true
      break
    }
  }
  if (!navigation) throw new Error('staged-diff sample navigation failed')
  // Export the baseline report (host writes it as a new local file).
  setStage('diff-export-baseline')
  elementOrThrow('diff-export').dispatchEvent(new Event('click'))
  await waitUntil(() => diff.pendingReportExport === null && status().includes('created'))
  if (!status().includes('JSON report created'))
    throw new Error('baseline report export did not complete')
  // Agreement fixture classes (queue done-when): identical, schema-only,
  // no-comparable, and nested-presence pairs, all staged through the REAL
  // select flow against the SAME opened A, all on the PRISTINE base view
  // (their reports claim baseViewOnly). A standalone profile-only pair is
  // impossible with a fully-matching confirmed key (any value change also
  // changes the row diff); the main pair already compares columnDeltas
  // field-for-field, so the profile aspect is covered there.
  const stageFixture = async (name: string): Promise<void> => {
    diff.stageFixtureForTest(name)
    elementOrThrow('comparison-select').dispatchEvent(new Event('click'))
    // The previous staging survives until the new one renders, so completion
    // is keyed on the staged-status line the renderer emits.
    await waitUntil(
      () =>
        status() === READY_STATUS ||
        status().includes('not be staged') ||
        status().includes('could not be staged'),
    )
    if (!status().startsWith('Comparison ready'))
      throw new Error(
        `staged-diff fixture staging failed: ${name} (status=${status().slice(0, 120)})`,
      )
  }
  const runConfirmed = async (): Promise<void> => {
    // Wait for a NEW report object — not merely a different-from-baseline
    // one: an identity check against a fixed earlier report can pass on a
    // stale report before this run finishes.
    const before = report()
    for (const option of [...select.options]) option.selected = option.value === 'id'
    elementOrThrow('diff-confirm').dispatchEvent(new Event('click'))
    await waitUntil(
      () =>
        report() !== null &&
        !busy() &&
        report() !== before &&
        report()?.revision === controller.snapshot.revision,
    )
  }
  const exportReport = async (stageLabel: string): Promise<void> => {
    setStage(stageLabel)
    elementOrThrow('diff-export').dispatchEvent(new Event('click'))
    await waitUntil(() => diff.pendingReportExport === null && status().includes('created'))
    if (!status().includes('JSON report created'))
      throw new Error(`staged-diff report export failed: ${stageLabel}`)
  }
  const classCheck = (label: string, check: (caseReport: DiffReportView) => void): boolean => {
    const caseReport = report()
    if (caseReport === null) throw new Error(`staged-diff class report missing: ${label}`)
    check(caseReport)
    return true
  }
  setStage('diff-case-identical')
  await stageFixture('comparison-identical.csv')
  await runConfirmed()
  const identicalCase = classCheck('identical', (caseReport) => {
    if (
      !caseReport.identical ||
      caseReport.aspects.some((aspect) => aspect.count !== 0) ||
      caseReport.drift.length !== 0
    ) {
      throw new Error('staged-diff identical-case invariant failed')
    }
  })
  await exportReport('diff-case-identical')
  setStage('diff-case-schema')
  await stageFixture('comparison-schema.csv')
  await runConfirmed()
  const schemaOnlyCase = classCheck('schema-only', (caseReport) => {
    if (
      caseReport.identical ||
      caseReport.drift.length !== 1 ||
      caseReport.aspects.some((aspect) => aspect.count !== 0)
    ) {
      throw new Error('staged-diff schema-only-case invariant failed')
    }
  })
  await exportReport('diff-case-schema')
  setStage('diff-case-onlykey')
  await stageFixture('comparison-onlykey.csv')
  await runConfirmed()
  const noComparableCase = classCheck('no-comparable', (caseReport) => {
    if (caseReport.changedComparable || caseReport.aspects[2].count !== 0)
      throw new Error('staged-diff no-comparable-case invariant failed')
  })
  await exportReport('diff-case-onlykey')
  setStage('diff-case-nested')
  await stageFixture('comparison-nested.parquet')
  await runConfirmed()
  const nestedCase = classCheck('nested', (caseReport) => {
    if (
      caseReport.identical ||
      caseReport.drift.length < 2 ||
      caseReport.aspects.some((aspect) => aspect.count !== 0) ||
      caseReport.changedComparable
    ) {
      throw new Error(
        `staged-diff nested-case invariant failed: identical=${String(caseReport.identical)} drift=${String(caseReport.drift.length)} counts=${caseReport.aspects.map((aspect) => aspect.count).join('/')} comparable=${String(caseReport.changedComparable)}`,
      )
    }
  })
  await exportReport('diff-case-nested')
  // Re-stage the primary comparison so the edit narrative runs against the
  // row-diff fixture, not the last class fixture.
  setStage('diff-restage-primary')
  await stageFixture('comparison-b.csv')
  await runConfirmed()
  // Accept an edit on the row with id=2 (currently equal to B): its value
  // change makes the changed aspect grow from 1 to 2 and flips the report stale.
  setStage('diff-edit-stale')
  const schema = await provider.schema()
  const idColumn = schema.findIndex((column) => column.name === 'id')
  const valueColumn = schema.findIndex((column) => column.name === 'value')
  if (idColumn < 0 || valueColumn < 0) throw new Error('staged-diff edit columns unavailable')
  let editedRowKey: string | undefined
  for (let start = 0; start < total; start += 128) {
    const page = await provider.fetchRange({
      startRow: start,
      endRow: Math.min(total, start + 128),
      startCol: 0,
      endCol: schema.length,
    })
    const offset = (page.rows ?? []).findIndex((row) => String(row[idColumn]) === '2')
    if (offset >= 0) {
      editedRowKey = page.rowKeys?.[offset]
      break
    }
  }
  if (editedRowKey === undefined) throw new Error('staged-diff edit target row not found')
  await controller.commitCell(editedRowKey as RowId, 'value', { kind: 'number', value: 555 })
  if (!isDiffStale(report(), controller.snapshot.revision))
    throw new Error('staged-diff stale predicate did not flip after edit')
  await waitUntil(() => !elementOrThrow('diff-stale').hidden)
  const staleAfterEdit = true
  // Re-diff the effective view: baseViewOnly must flip to false and the
  // changed aspect must reflect the accepted edit (1 -> 2).
  setStage('diff-edited')
  const preEditReport = report()
  for (const option of [...select.options]) option.selected = option.value === 'id'
  elementOrThrow('diff-confirm').dispatchEvent(new Event('click'))
  await waitUntil(
    () =>
      report() !== null &&
      !busy() &&
      report() !== preEditReport &&
      report()?.revision === controller.snapshot.revision,
  )
  const edited = report()
  if (edited === null) throw new Error('edited diff did not publish a report')
  if (edited.baseViewOnly || edited.aspects[2].count !== 2)
    throw new Error('staged-diff edited baseViewOnly/changed-count invariant failed')
  await waitUntil(() => Boolean(elementOrThrow('diff-stale').hidden))
  const baseViewOnlyFalse = true
  const editedChangedCount = edited.aspects[2].count
  // Export the edited report, then the effective copy for the CLI agreement
  // leg — the copy must be the LAST parquet artifact of this open so the
  // runner's max-index pick is the edited view (a later unconditional
  // export would re-export the same accepted state, so order is safe).
  setStage('diff-export-edited')
  elementOrThrow('diff-export').dispatchEvent(new Event('click'))
  await waitUntil(() => diff.pendingReportExport === null && status().includes('created'))
  if (!status().includes('JSON report created'))
    throw new Error('edited report export did not complete')
  setStage('diff-export-copy')
  await exportEffectiveCopy()
  return {
    unconfirmedRefused,
    staleAfterEdit,
    baseViewOnlyFalse,
    navigation,
    baselineCounts,
    editedChangedCount,
    identicalCase,
    schemaOnlyCase,
    noComparableCase,
    nestedCase,
  }
}

/**
 * The compare COMMAND opened this panel: prove it reached the SAME
 * confirmed-key controller — comparison staged through the real bridge,
 * execution refused without confirmed keys, then ONE confirmed baseline run
 * with exact counts. Edits/classes/exports belong to the full scenario.
 */
export async function exerciseCommandDiff(input: DiffProofInput): Promise<CommandDiffProofResult> {
  const { diff, controller, setStage } = input
  const status = (): string => elementOrThrow('diff-status').textContent ?? ''
  const report = (): DiffReportView | null => diff.publishedReport
  setStage('diff-command-wait-staged')
  await waitUntil(() => diff.comparisonIsStaged || status().includes('could not be staged'))
  if (!diff.comparisonIsStaged) throw new Error('compare command did not stage the comparison')
  setStage('diff-command-refusal')
  elementOrThrow('diff-confirm').dispatchEvent(new Event('click'))
  // The proof value is DERIVED from the observed refusal — a harness that
  // skips the observation cannot report the gate as proven.
  const refusalStatus = status()
  const unconfirmedRefused = refusalStatus.startsWith('Diff refused: invalid keys')
  if (!unconfirmedRefused) throw new Error('compare command path ran a diff without confirmed keys')
  setStage('diff-command-baseline')
  const select = elementOrThrow('diff-keys') as HTMLSelectElement
  for (const option of [...select.options]) option.selected = option.value === 'id'
  elementOrThrow('diff-confirm').dispatchEvent(new Event('click'))
  await waitUntil(
    () => report() !== null && !diff.running && report()?.revision === controller.snapshot.revision,
  )
  const baseline = report()
  if (baseline === null) throw new Error('compare command confirmed diff did not publish a report')
  const counts = baseline.aspects.map((aspect) => aspect.count) as [number, number, number]
  if (counts[0] !== 1 || counts[1] !== 1 || counts[2] !== 1 || baseline.identical)
    throw new Error('compare command baseline counts invariant failed')
  return { staged: diff.comparisonIsStaged, unconfirmedRefused, baselineCounts: counts }
}
