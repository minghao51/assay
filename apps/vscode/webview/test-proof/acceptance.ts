// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Acceptance-chain proof orchestration (D03b) — one dataset, one chained
 * workflow (MVP scenario 11 on the desktop): validate → edit → undo → redo →
 * confirmed-key diff → report + effective-copy delivery, all driven through
 * the REAL validation and diff panels.
 *
 * TEST-PROOF code: reached only through `webview/test-proof/index.ts`, which
 * the entry calls only when `config.testHarness` is set (host:
 * `ExtensionMode.Test`).
 */
import type { RowId } from '@assay/domain'
import { isValidationStale } from '../../src/pure/validation-controller'
import type { ValidationProjection } from '../../src/pure/validation-controller'
import type { EditController } from '../../src/pure/edit-controller'
import type { WebviewDataGrid } from '../data-grid'
import type { DiffPanel } from '../diff-panel'
import { elementOrThrow } from '../dom'
import type { EngineGridProvider } from '../grid-provider'
import type { ValidationPanel } from '../validation-panel'
import { waitUntil } from './harness'

/** The `acceptanceProof` payload of the `opened` message. */
export interface AcceptanceProofResult {
  readonly validatedCounts: readonly [number, number, number, number]
  readonly staleAfterEdit: boolean
  readonly unconfirmedRefused: boolean
  readonly refusalKind: 'invalid-keys' | 'not-observed'
  readonly diffCounts: readonly [number, number, number]
  readonly baseViewOnlyFalse: boolean
  readonly navigation: boolean
  readonly reportDelivered: boolean
  readonly copyDelivered: boolean
}

/** Explicit inputs of the acceptance proof. */
export interface AcceptanceProofInput {
  readonly validation: ValidationPanel
  readonly diff: DiffPanel
  readonly controller: EditController
  readonly provider: EngineGridProvider
  readonly grid: WebviewDataGrid
  readonly exportEffectiveCopy: () => Promise<void>
  readonly setStage: (stage: string) => void
}

export async function exerciseAcceptance(
  input: AcceptanceProofInput,
): Promise<AcceptanceProofResult> {
  const { validation, diff, controller, provider, grid, exportEffectiveCopy, setStage } = input
  const status = (): string => elementOrThrow('diff-status').textContent ?? ''
  // One dataset, one chained workflow (MVP scenario 11 on the desktop):
  // validate -> edit -> undo -> redo -> confirmed-key diff -> report + copy.
  setStage('acceptance-reset')
  while (controller.snapshot.history.cursor > 0) await controller.undo()
  setStage('acceptance-contract')
  elementOrThrow('contract-select').dispatchEvent(new Event('click'))
  await waitUntil(() => validation.selectedContract !== null || validation.pendingRequest === null)
  if (validation.selectedContract === null) throw new Error('acceptance contract selection failed')
  const run = async (): Promise<number> => {
    await validation.run()
    const report: ValidationProjection | null = validation.publishedReport
    if (report === null || report.revision !== controller.snapshot.revision)
      throw new Error('acceptance validation did not publish a current verdict')
    return report.rules[0]?.failCount ?? -1
  }
  setStage('acceptance-validate-baseline')
  const baselineFailures = await run()
  if (baselineFailures !== 1) throw new Error('acceptance validation baseline invariant failed')
  // Edit the null row's value_maybe_null; the effective view becomes valid.
  setStage('acceptance-edit')
  const schema = await provider.schema()
  const idColumn = schema.findIndex((column) => column.name === 'id')
  if (idColumn < 0) throw new Error('acceptance id column unavailable')
  const total = await provider.rowCount()
  let targetKey: string | undefined
  for (let start = 0; start < total; start += 128) {
    const page = await provider.fetchRange({
      startRow: start,
      endRow: Math.min(total, start + 128),
      startCol: 0,
      endCol: schema.length,
    })
    const offset = (page.rows ?? []).findIndex((row) => String(row[idColumn]) === '6')
    if (offset >= 0) {
      targetKey = page.rowKeys?.[offset]
      break
    }
  }
  if (targetKey === undefined) throw new Error('acceptance edit target row not found')
  await controller.commitCell(targetKey as RowId, 'value_maybe_null', {
    kind: 'number',
    value: 9.5,
  })
  const published = validation.publishedReport
  if (published === null || !isValidationStale(published, controller.snapshot.revision))
    throw new Error('acceptance stale invariant failed after edit')
  const staleAfterEdit = true
  setStage('acceptance-validate-edited')
  const editedFailures = await run()
  if (editedFailures !== 0) throw new Error('acceptance edited validation invariant failed')
  setStage('acceptance-undo')
  await controller.undo()
  const undoneFailures = await run()
  if (undoneFailures !== 1) throw new Error('acceptance undone validation invariant failed')
  setStage('acceptance-redo')
  await controller.redo()
  const redoneFailures = await run()
  if (redoneFailures !== 0) throw new Error('acceptance redone validation invariant failed')
  // Confirmed-key diff against the staged comparison — B mirrors the
  // EDITED view except one changed, one removed, one added row.
  setStage('acceptance-stage')
  diff.stageFixtureForTest('acceptance-b.csv')
  elementOrThrow('comparison-select').dispatchEvent(new Event('click'))
  await waitUntil(() => diff.comparisonIsStaged || status().includes('could not be staged'))
  if (!diff.comparisonIsStaged) throw new Error('acceptance comparison staging failed')
  setStage('acceptance-refusal')
  elementOrThrow('diff-confirm').dispatchEvent(new Event('click'))
  const refusalStatus = status()
  const unconfirmedRefused = refusalStatus.startsWith('Diff refused: invalid keys')
  // A SECOND, independently-normalized derivation of the same observation:
  // deleting the observation (and hardcoding the boolean above) leaves this
  // field 'not-observed' and the host normalizer rejects the whole proof.
  const refusalKind: 'invalid-keys' | 'not-observed' = refusalStatus.startsWith('Diff refused')
    ? 'invalid-keys'
    : 'not-observed'
  if (refusalKind !== 'invalid-keys') throw new Error('acceptance diff ran without confirmed keys')
  setStage('acceptance-diff')
  const select = elementOrThrow('diff-keys') as HTMLSelectElement
  for (const option of [...select.options]) option.selected = option.value === 'id'
  elementOrThrow('diff-confirm').dispatchEvent(new Event('click'))
  await waitUntil(
    () =>
      diff.publishedReport !== null &&
      !diff.running &&
      diff.publishedReport.revision === controller.snapshot.revision &&
      diff.publishedReport.baseViewOnly === false,
  )
  const report = diff.publishedReport
  if (report === null) throw new Error('acceptance diff did not publish a report')
  const diffCounts = report.aspects.map((aspect) => aspect.count) as [number, number, number]
  if (diffCounts[0] !== 1 || diffCounts[1] !== 1 || diffCounts[2] !== 1 || report.identical)
    throw new Error('acceptance diff counts invariant failed')
  const baseViewOnlyFalse = !report.baseViewOnly
  setStage('acceptance-navigation')
  const changedAspect = report.aspects[2]
  const sample = changedAspect.samples.find((entry) => entry.side === 'A')
  if (sample === undefined) throw new Error('acceptance diff has no A-side sample')
  let navigation = false
  for (let start = 0; start < total; start += 128) {
    const page = await provider.fetchRange({
      startRow: start,
      endRow: Math.min(total, start + 128),
      startCol: 0,
      endCol: schema.length,
    })
    const offset = (page.rowKeys ?? []).indexOf(sample.rowKey)
    if (offset >= 0) {
      grid.scrollToRow(start + offset)
      navigation = true
      break
    }
  }
  if (!navigation) throw new Error('acceptance sample navigation failed')
  // Deliver the report (create-only) and the effective copy.
  setStage('acceptance-report')
  elementOrThrow('diff-export').dispatchEvent(new Event('click'))
  await waitUntil(() => diff.pendingReportExport === null && status().includes('created'))
  const reportDelivered = status().includes('JSON report created')
  if (!reportDelivered) throw new Error('acceptance report export did not complete')
  setStage('acceptance-copy')
  await exportEffectiveCopy()
  const copyDelivered = true
  return {
    validatedCounts: [baselineFailures, editedFailures, undoneFailures, redoneFailures],
    staleAfterEdit,
    unconfirmedRefused,
    refusalKind,
    diffCounts,
    baseViewOnlyFalse,
    navigation,
    reportDelivered,
    copyDelivered,
  }
}
