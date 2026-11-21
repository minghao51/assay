// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Effective-view validation proof orchestration (D03b) — proves the desktop
 * validation panel against the REAL contract-selection and validate controls:
 * a baseline verdict, logical-row navigation, the stale flip after an accepted
 * edit, and the effective edit/insert/delete verdicts, restoring the original
 * overlay before returning.
 *
 * TEST-PROOF code: reached only through `webview/test-proof/index.ts`, which
 * the entry calls only when `config.testHarness` is set (host:
 * `ExtensionMode.Test`).
 */
import type { RowId } from '@assay/domain'
import type { GridViewportModel } from '@assay/grid'
import { isValidationStale } from '../../src/pure/validation-controller'
import type { ValidationProjection } from '../../src/pure/validation-controller'
import type { EditController } from '../../src/pure/edit-controller'
import type { WebviewDataGrid } from '../data-grid'
import { elementOrThrow } from '../dom'
import type { EngineGridProvider } from '../grid-provider'
import type { ValidationPanel } from '../validation-panel'
import { waitUntil } from './harness'

/** The `validationProof` payload of the `opened` message. */
export interface ValidationProofResult {
  readonly baselineFailures: number
  readonly editedFailures: number
  readonly insertedFailures: number
  readonly deletedFailures: number
  readonly staleAfterEdit: boolean
  readonly logicalNavigation: boolean
}

/** Explicit inputs of the validation proof. */
export interface ValidationProofInput {
  readonly validation: ValidationPanel
  readonly controller: EditController
  readonly provider: EngineGridProvider
  readonly grid: WebviewDataGrid
  readonly model: GridViewportModel
  readonly setStage: (stage: string) => void
}

export async function exerciseEffectiveValidation(
  input: ValidationProofInput,
): Promise<ValidationProofResult> {
  const { validation, controller, provider, grid, model, setStage } = input
  setStage('validation-contract-select')
  elementOrThrow('contract-select').dispatchEvent(new Event('click'))
  await waitUntil(() => validation.selectedContract !== null || validation.pendingRequest === null)
  if (validation.selectedContract === null) throw new Error('validation contract selection failed')
  const startingCursor = controller.snapshot.history.cursor
  const run = async (): Promise<ValidationProjection> => {
    await validation.run()
    const report = validation.publishedReport
    if (report === null || report.revision !== controller.snapshot.revision)
      throw new Error('validation controller did not publish a current verdict')
    return report
  }
  setStage('validation-baseline')
  const baseline = await run()
  const rule = baseline.rules[0]
  const sample = rule?.samples[0]
  if (rule === undefined || sample === undefined || rule.failCount !== 1)
    throw new Error('validation baseline invariant failed')
  setStage('validation-navigation')
  let logicalNavigation = false
  const count = await provider.rowCount()
  for (let start = 0; start < count; start += 128) {
    const page = await provider.fetchRange({
      startRow: start,
      endRow: Math.min(count, start + 128),
      startCol: 0,
      endCol: (await provider.schema()).length,
    })
    const offset = (page.rowKeys ?? []).indexOf(sample.rowKey)
    if (offset >= 0) {
      grid.scrollToRow(start + offset)
      logicalNavigation = true
      break
    }
  }
  if (!logicalNavigation) throw new Error('validation logical-row navigation failed')
  setStage('validation-edit')
  await controller.commitCell(sample.rowKey as RowId, 'value_maybe_null', {
    kind: 'number',
    value: 9.5,
  })
  const staleAfterEdit = isValidationStale(baseline, controller.snapshot.revision)
  validation.refreshStale()
  if (!staleAfterEdit || elementOrThrow('validation-stale').hidden)
    throw new Error('validation stale invariant failed')
  const edited = await run()
  if (edited.rules[0]?.failCount !== 0)
    throw new Error('validation effective edit invariant failed')
  await controller.undo()
  setStage('validation-insert')
  await controller.insertRow()
  const inserted = await run()
  if (inserted.rowCount !== baseline.rowCount + 1 || inserted.rules[0]?.failCount !== 2)
    throw new Error('validation effective insert invariant failed')
  await controller.undo()
  setStage('validation-delete-operation')
  await controller.deleteRow(sample.rowKey as RowId)
  setStage('validation-delete-run')
  const deleted = await run()
  setStage('validation-delete-check')
  if (deleted.rowCount !== baseline.rowCount - 1 || deleted.rules[0]?.failCount !== 0)
    throw new Error('validation effective delete invariant failed')
  await controller.undo()
  if (controller.snapshot.history.cursor !== startingCursor)
    throw new Error('validation proof did not restore the original overlay')
  await model.setSort(null)
  await model.setFilters([])
  await model.refresh()
  grid.scrollToRow(0)
  await grid.whenFirstRowVisible()
  return {
    baselineFailures: rule.failCount,
    editedFailures: edited.rules[0]!.failCount,
    insertedFailures: inserted.rules[0]!.failCount,
    deletedFailures: deleted.rules[0]!.failCount,
    staleAfterEdit,
    logicalNavigation,
  }
}
