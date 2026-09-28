// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useRef, useState } from 'react'
import { stateAtCursor } from '@assay/domain'
import type { TransformationHistory } from '@assay/domain'
import type { EngineOverlay } from '@assay/engine-duckdb'
import { parseContract } from '@assay/contracts'
import { compileContract } from '@assay/validation'
import { engineRejectionMessage, overlaySnapshot } from '../edit/session'
import { engineClient } from '../lib/engine'
import { readContractFile } from '../validation/contract-import'
import { buildValidationReport, resolveRowKeyIndex } from '../validation/report-model'
import type { ValidationReportRow } from '../validation/report-model'
import { requestReportDestination } from '../validation/report-export'
import type { ReportExportFormat } from '../validation/report-export'
import type { ContractState, ValidationRunState } from '../validation/ValidationPanel'
import type { SourceIdentity } from '../export/save-destination'
import type { DatasetSession } from './session-reset'
import type { NavigateToRow, Phase } from './types'

/**
 * m5-3 validation binding name and sample bound. The plan's `relation` is
 * the binding name the engine materializes the effective view under — not a
 * registered table view (which are `assay_tN`, and which the engine's plan
 * gate would refuse to shadow). K aligns with the engine's hard sample max
 * (100) so the panel's sample list is as complete as the engine allows; the
 * engine clamps anyway (`min(K, 100)`), so this is a floor, not a promise.
 */
const VALIDATION_RELATION = 'assay_validation_target'
const VALIDATION_SAMPLE_LIMIT = 100

export interface ValidationSessionParams {
  readonly phase: Phase
  readonly session: DatasetSession
  /** Synchronous active-history mirror (see `useEditingSession`). */
  readonly historyRef: { current: TransformationHistory }
  /** Synchronous active-overlay mirror (see `useEditingSession`). */
  readonly overlayRef: { current: EngineOverlay | null }
  readonly overlayRevision: number
  /**
   * Source identity retained by the open flow; the report export threads it
   * into the same-source guard (m4-5 pattern).
   */
  readonly sourceIdentityRef: { current: SourceIdentity | null }
  /** Shared grid navigation (scroll + open record inspector). */
  readonly navigateToRow: NavigateToRow
}

export interface ValidationSession {
  readonly contractState: ContractState
  readonly validationRun: ValidationRunState
  readonly jumpError: string | null
  readonly filterToFailuresError: string | null
  /** A verdict computed against a superseded overlay revision. */
  readonly validationStale: boolean
  readonly handleContractFile: (file: File) => void
  readonly handleValidate: () => void
  readonly handleCancelValidate: () => void
  readonly handleJumpToSample: (rowKey: string) => void
  readonly handleFilterToFailures: (row: ValidationReportRow) => void
  readonly requestReportDestinationForPanel: typeof requestReportDestination
}

/**
 * m5-3 validation session (extracted from `App` by f-1). `contractState` is
 * the imported contract (none / parse errors / over-bound / loaded);
 * `validationRun` is the run state machine (idle / running / cancelled /
 * failed / binding errors / verdict). A verdict stores the `overlayRevision`
 * it ran against; `validationStale` is the honest freshness signal — ANY
 * history activation (edit, undo, redo, cursor move) marks an existing
 * verdict stale, and re-validation is an explicit click (no auto-revalidate:
 * an editing session triggers many revisions per fix, and a debounced
 * auto-run would spend query-lane work on verdicts that are already stale
 * again). The verdict stays viewable under the stale banner (m4-3 dirty-state
 * discipline).
 *
 * The hook registers its reset with the dataset session: a new file drops the
 * previous contract and verdict and bumps `validationSeq` so an in-flight run
 * is abandoned.
 */
export function useValidationSession(params: ValidationSessionParams): ValidationSession {
  const {
    phase,
    session,
    historyRef,
    overlayRef,
    overlayRevision,
    sourceIdentityRef,
    navigateToRow,
  } = params

  const [contractState, setContractState] = useState<ContractState>({ kind: 'none' })
  const [validationRun, setValidationRun] = useState<ValidationRunState>({ kind: 'idle' })
  /**
   * Monotonic run token: the validate path captures it at request time and
   * drops a result that is no longer current (the m2-4 UI-level-cancellation
   * discipline — the engine op itself completes; cancellation abandons the
   * result, and the status line says so).
   */
  const validationSeq = useRef(0)
  /** Jump/filter feedback for the panel (readable, value-free). */
  const [jumpError, setJumpError] = useState<string | null>(null)
  const [filterToFailuresError, setFilterToFailuresError] = useState<string | null>(null)

  /**
   * Freshness: a verdict (or binding-error report) stores the overlay
   * revision it was produced against; any history activation marks it stale
   * and re-validation is an explicit click. The verdict stays viewable under
   * the stale banner (m4-3 dirty-state discipline).
   *
   * Busy policy: `validate` runs on the engine's query lane (ADR 0040), so
   * the grid stays interactive. Cancellation is UI-level abandonment (the
   * m2-4 pattern — the engine op itself completes; an abandoned result is
   * dropped by seq and the panel says "cancelled"). A second run cannot
   * start while one is in flight.
   */
  const validationStale =
    (validationRun.kind === 'verdict' || validationRun.kind === 'binding-errors') &&
    validationRun.revision !== overlayRevision

  const handleContractFile = useCallback(
    (file: File) => {
      const sessionId = session.tokenRef.current
      void (async () => {
        const imported = await readContractFile(file)
        // AR-W9: the read awaits, so a re-open that happened meanwhile means
        // this contract was authored for the previous dataset — discard it
        // (the house session-token guard used by validate/diff/cast).
        if (session.tokenRef.current !== sessionId) return
        if (imported.kind === 'too-large') {
          setContractState({ kind: 'too-large' })
        } else if (imported.kind === 'read-failed') {
          setContractState({ kind: 'read-failed', message: imported.message })
        } else {
          const parsed = parseContract(imported.text)
          setContractState(
            parsed.ok
              ? { kind: 'loaded', contract: parsed.contract }
              : { kind: 'parse-error', errors: parsed.errors },
          )
        }
        // A newly imported contract invalidates any previous verdict: the old
        // report described rules this contract may no longer contain.
        setValidationRun({ kind: 'idle' })
        setJumpError(null)
        setFilterToFailuresError(null)
      })()
    },
    [session],
  )

  const handleValidate = useCallback(() => {
    if (phase.kind !== 'ready' || contractState.kind !== 'loaded') return
    const sessionId = session.tokenRef.current
    const seq = ++validationSeq.current
    const revision = overlayRevision
    const { base, handle } = phase
    const contract = contractState.contract
    setValidationRun({ kind: 'running' })
    void (async () => {
      try {
        // Compile against the CURRENT effective schema (post-rename/cast at
        // the history cursor) — the same effective view the plan then
        // executes over, so binding errors and verdicts always describe the
        // dataset as it is now.
        const effective = stateAtCursor(base, historyRef.current)
        const compiled = compileContract(contract, effective.columns, {
          relation: VALIDATION_RELATION,
          sampleLimit: VALIDATION_SAMPLE_LIMIT,
        })
        if (session.tokenRef.current !== sessionId) return
        if (!compiled.ok) {
          if (seq === validationSeq.current) {
            setValidationRun({ kind: 'binding-errors', errors: compiled.errors, revision })
          }
          return
        }
        const overlay = overlayRef.current ?? overlaySnapshot(base, historyRef.current)
        const result = await engineClient.validate(handle, compiled.plan, overlay)
        if (session.tokenRef.current !== sessionId) return
        // Superseded or abandoned (cancel/new run): drop the stale result.
        if (seq !== validationSeq.current) return
        setValidationRun({
          kind: 'verdict',
          report: buildValidationReport(compiled.plan, result, contract),
          revision,
        })
      } catch (error) {
        if (session.tokenRef.current !== sessionId || seq !== validationSeq.current) return
        setValidationRun({ kind: 'failed', message: engineRejectionMessage(error) })
      }
    })()
  }, [phase, contractState, overlayRevision, session, historyRef, overlayRef])

  const handleCancelValidate = useCallback(() => {
    validationSeq.current += 1
    setValidationRun({ kind: 'cancelled' })
  }, [])

  /**
   * Jump-to-row: resolve the sample's logical row key in the CURRENT
   * effective view (m4-3 row-key channel), scroll the grid there, and open
   * the record inspector. A key the current view no longer contains (the
   * row was deleted after the verdict) is an honest, readable error.
   */
  const handleJumpToSample = useCallback(
    (rowKey: string) => {
      if (phase.kind !== 'ready') return
      const state = stateAtCursor(phase.base, historyRef.current)
      const resolution = resolveRowKeyIndex(phase.base, state, rowKey)
      if (resolution.kind === 'missing') {
        setJumpError(
          'That row is no longer in the current view — it may have been deleted after the verdict was computed. Re-validate for a fresh report.',
        )
        return
      }
      setJumpError(null)
      navigateToRow(resolution.rowIndex)
    },
    [phase, historyRef, navigateToRow],
  )

  /**
   * Filter-to-failures: apply the rule's single-column predicate through the
   * m2-2 filter channel, REPLACING the active filter list (the control is a
   * view toggle, not an accumulation — the resulting view is "only the rows
   * failing this rule"). An engine rejection restores the previous filters
   * (the grid contract's rejection-leaves-state rule) and surfaces readable
   * text; the m4-3 rollback convention, applied to filters.
   */
  const handleFilterToFailures = useCallback(
    (row: ValidationReportRow) => {
      if (phase.kind !== 'ready') return
      if (row.filter.kind !== 'ready' || row.column === null) return
      const column = row.column
      const predicate = row.filter.predicate
      void (async () => {
        const previous = phase.model.filters
        try {
          await phase.model.setFilters([{ column, predicate }])
          setFilterToFailuresError(null)
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause)
          try {
            await phase.model.setFilters(previous)
            setFilterToFailuresError(
              `The grid rejected the failure filter (${message}). The previous filters are back in effect.`,
            )
          } catch {
            setFilterToFailuresError(
              'The grid rejected the failure filter, and restoring the previous filters also failed. Clear filters manually.',
            )
          }
        }
      })()
    },
    [phase],
  )

  /** m4-5 pattern for the report: destination with the same-source guard. */
  const requestReportDestinationForPanel = useCallback(
    (format: ReportExportFormat) =>
      requestReportDestination(format, {
        sourceIdentity: sourceIdentityRef.current ?? undefined,
      }),
    [sourceIdentityRef],
  )

  /**
   * New-dataset reset: drop the previous contract and verdict, clear the
   * panel feedback, and bump `validationSeq` so an in-flight run is
   * abandoned.
   */
  const reset = useCallback(() => {
    setContractState({ kind: 'none' })
    setValidationRun({ kind: 'idle' })
    setJumpError(null)
    setFilterToFailuresError(null)
    validationSeq.current += 1
  }, [])
  useEffect(() => session.registerReset(reset), [session, reset])

  return {
    contractState,
    validationRun,
    jumpError,
    filterToFailuresError,
    validationStale,
    handleContractFile,
    handleValidate,
    handleCancelValidate,
    handleJumpToSample,
    handleFilterToFailures,
    requestReportDestinationForPanel,
  }
}
