// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useRef, useState } from 'react'
import { displayRowKey, stateAtCursor } from '@assay/domain'
import type { TransformationHistory } from '@assay/domain'
import type { EngineComparisonHandle, EngineOverlay } from '@assay/engine-duckdb'
import { compileRowDiffPlan, diffDatasets, inferRowDiffKeys } from '@assay/diff'
import { engineErrorMessage, overlaySnapshot } from '../edit/session'
import { engineClient } from '../lib/engine'
import { resolveRowKeyIndex } from '../validation/report-model'
import {
  buildDiffPanelReport,
  DIFF_PLAN_RELATION_A,
  DIFF_PLAN_RELATION_B,
  DIFF_SAMPLE_LIMIT,
  toDiffProfile,
} from '../diff/diff-model'
import type { DiffKeyDisclosure } from '../diff/diff-model'
import { requestDiffReportDestination } from '../diff/diff-export'
import type { DiffReportFormat } from '../diff/diff-export'
import type { ComparisonState, DiffRunState } from '../diff/DiffPanel'
import type { SourceIdentity } from '../export/save-destination'
import type { DatasetSession } from './session-reset'
import type { NavigateToRow, Phase } from './types'

export interface DiffSessionParams {
  readonly phase: Phase
  readonly session: DatasetSession
  /** Synchronous active-history mirror (see `useEditingSession`). */
  readonly historyRef: { current: TransformationHistory }
  /** Synchronous active-overlay mirror (see `useEditingSession`). */
  readonly overlayRef: { current: EngineOverlay | null }
  readonly overlayRevision: number
  /** Source identity retained by the open flow (m4-5 same-source guard). */
  readonly sourceIdentityRef: { current: SourceIdentity | null }
  /** Shared grid navigation (scroll + open record inspector). */
  readonly navigateToRow: NavigateToRow
}

export interface DiffSession {
  readonly comparisonState: ComparisonState
  readonly diffRun: DiffRunState
  readonly diffJumpError: string | null
  /** A diff computed against a superseded overlay revision. */
  readonly diffStale: boolean
  readonly handleComparisonFile: (file: File) => void
  readonly handleRunDiff: (
    keys: readonly string[],
    keySource: 'explicit' | 'inferred',
    inference: DiffKeyDisclosure | null,
  ) => void
  readonly handleCancelDiff: () => void
  readonly handleJumpToDiffSample: (rowKey: string) => void
  readonly requestDiffReportDestinationForPanel: typeof requestDiffReportDestination
}

/**
 * m6-4 comparison session (extracted from `App` by f-1). `comparisonState`
 * is the staged comparison (none / staging / failed / staged) and `diffRun`
 * is the row-diff run state machine. `comparisonSeq`/`diffSeq` are the
 * UI-level generation guards (the m5-3 pattern): a superseded or abandoned
 * result is dropped, and a comparison staged against a dead dataset epoch
 * never lands. `comparisonRef` holds the engine's opaque comparison handle
 * (never rendered); `diffStale` marks a result computed before the latest
 * edit.
 *
 * The hook registers its reset with the dataset session: a new file drops a
 * staged comparison and any row diff, clears the jump feedback, releases the
 * comparison handle, and bumps both sequence guards.
 */
export function useDiffSession(params: DiffSessionParams): DiffSession {
  const {
    phase,
    session,
    historyRef,
    overlayRef,
    overlayRevision,
    sourceIdentityRef,
    navigateToRow,
  } = params

  const [comparisonState, setComparisonState] = useState<ComparisonState>({ kind: 'none' })
  const [diffRun, setDiffRun] = useState<DiffRunState>({ kind: 'idle' })
  const [diffJumpError, setDiffJumpError] = useState<string | null>(null)
  const comparisonSeq = useRef(0)
  const diffSeq = useRef(0)
  const comparisonRef = useRef<EngineComparisonHandle | null>(null)
  /**
   * f-2: latest overlay revision without making `handleRunDiff` depend on
   * it. The diff result records the revision it ran against; reading a ref
   * at click time keeps that value current while leaving the callback
   * identity stable across edit commits, so the memoized diff panel is not
   * forced to re-render by an ordinary cell edit.
   */
  const overlayRevisionRef = useRef(overlayRevision)
  overlayRevisionRef.current = overlayRevision

  /**
   * m6-4 freshness: a row diff (or binding-error report) computed before the
   * latest overlay activation is stale — the effective view it described has
   * changed. The result stays viewable under the stale banner; re-running is
   * an explicit click (no auto-run).
   */
  const diffStale =
    (diffRun.kind === 'result' && diffRun.report.revision !== overlayRevision) ||
    (diffRun.kind === 'binding-errors' && diffRun.revision !== overlayRevision)

  /**
   * m6-4 comparison staging (checkpoint C3). The picked file is read locally,
   * staged through the engine's typed comparison op (single-slot scratch,
   * never the source path) for the row diff, and opened transiently to obtain
   * its profile aggregates — the engine profiles registered tables, and the
   * comparison view is not one. The opened handle is profile-only: the
   * comparison never becomes a grid and no second grid model is created. A
   * staging failure stages nothing; a superseded stage is dropped by seq.
   */
  const handleComparisonFile = useCallback(
    (file: File) => {
      if (phase.kind !== 'ready') return
      const sessionId = session.tokenRef.current
      const seq = ++comparisonSeq.current
      setComparisonState({ kind: 'staging' })
      setDiffRun({ kind: 'idle' })
      setDiffJumpError(null)
      comparisonRef.current = null
      void (async () => {
        try {
          const source = { name: file.name, getFile: () => Promise.resolve(file) }
          const comparison = await engineClient.stageComparison(source)
          const handleB = await engineClient.open(source)
          const [profileA, profileB] = await Promise.all([
            engineClient.profile(phase.handle),
            engineClient.profile(handleB),
          ])
          if (session.tokenRef.current !== sessionId || seq !== comparisonSeq.current) return
          comparisonRef.current = comparison
          const schemaA = phase.base.columns
          const diffProfileA = toDiffProfile(profileA)
          const diffProfileB = toDiffProfile(profileB)
          const diff = diffDatasets({
            schemaA,
            schemaB: comparison.schema,
            profileA: diffProfileA,
            profileB: diffProfileB,
          })
          setComparisonState({
            kind: 'staged',
            schemaB: comparison.schema.map((column) => ({ name: column.name, type: column.type })),
            rowCountB: diffProfileB.rowCount,
            baseColumnCount: schemaA.length,
            diff,
            inference: inferRowDiffKeys(diffProfileA, diffProfileB),
          })
        } catch (error) {
          if (session.tokenRef.current !== sessionId || seq !== comparisonSeq.current) return
          setComparisonState({
            kind: 'failed',
            // UG-25: comparison staging is read-only — the diff framing names
            // the comparison view that stays in effect, never an "edit".
            message: engineErrorMessage('diff', error),
          })
        }
      })()
    },
    [phase, session],
  )

  /**
   * Run the confirmed-key row diff. The plan is compiled against the CURRENT
   * effective schema (post-rename/cast at the history cursor) so binding and
   * changed-column names match the view side A binds to, then executed over
   * the effective view (base + overlay) — the same view the grid shows. A
   * compile binding error is first-class panel content (the m5-3 pattern);
   * the result stores the overlay revision it ran against for the stale
   * banner. UI-level cancel abandons the result via the seq guard.
   */
  const handleRunDiff = useCallback(
    (
      keys: readonly string[],
      keySource: 'explicit' | 'inferred',
      inference: DiffKeyDisclosure | null,
    ) => {
      if (phase.kind !== 'ready' || comparisonState.kind !== 'staged') return
      const comparison = comparisonRef.current
      if (comparison === null) return
      const sessionId = session.tokenRef.current
      const seq = ++diffSeq.current
      const revision = overlayRevisionRef.current
      const { diff, schemaB } = comparisonState
      setDiffRun({ kind: 'running' })
      void (async () => {
        try {
          const effective = stateAtCursor(phase.base, historyRef.current)
          const compiled = compileRowDiffPlan(effective.columns, schemaB, keys, {
            relationA: DIFF_PLAN_RELATION_A,
            relationB: DIFF_PLAN_RELATION_B,
            sampleLimit: DIFF_SAMPLE_LIMIT,
          })
          if (session.tokenRef.current !== sessionId || seq !== diffSeq.current) return
          if (!compiled.ok) {
            setDiffRun({ kind: 'binding-errors', errors: compiled.errors, revision })
            return
          }
          const overlay = overlayRef.current ?? overlaySnapshot(phase.base, historyRef.current)
          const result = await engineClient.diff(phase.handle, comparison, compiled.plan, overlay)
          if (session.tokenRef.current !== sessionId || seq !== diffSeq.current) return
          setDiffRun({
            kind: 'result',
            report: buildDiffPanelReport({
              diff,
              result,
              keys,
              keySource,
              inference,
              sharedColumns: compiled.plan.sharedColumns,
              sampleLimitRequested: DIFF_SAMPLE_LIMIT,
              sampleLimitEffective: DIFF_SAMPLE_LIMIT,
              baseViewOnly: (overlay.ops?.length ?? 0) === 0,
              revision,
            }),
          })
        } catch (error) {
          if (session.tokenRef.current !== sessionId || seq !== diffSeq.current) return
          setDiffRun({
            kind: 'failed',
            // UG-25/UG-30: single-line, read-only framing (no "edit" leak).
            message: engineErrorMessage('diff', error),
          })
        }
      })()
    },
    [phase, comparisonState, session, historyRef, overlayRef],
  )

  const handleCancelDiff = useCallback(() => {
    diffSeq.current += 1
    setDiffRun({ kind: 'cancelled' })
  }, [])

  /**
   * Jump-to-row for an A-side diff sample: resolve the logical row key in the
   * CURRENT effective view (m4-3 row-key channel), scroll/open the inspector
   * and move roving focus to the row. A key the current view no longer
   * contains is readable, never silent, and announces nothing. B-side keys
   * never reach here (the panel shows no jump there). ug-12: the sample's
   * domain display key rides along for the value-free announcement.
   */
  const handleJumpToDiffSample = useCallback(
    (rowKey: string) => {
      if (phase.kind !== 'ready') return
      const state = stateAtCursor(phase.base, historyRef.current)
      const resolution = resolveRowKeyIndex(phase.base, state, rowKey)
      if (resolution.kind === 'missing') {
        setDiffJumpError(
          'That row is no longer in the current view — it may have been deleted or changed after the diff ran. Run the diff again for a fresh report.',
        )
        return
      }
      setDiffJumpError(null)
      navigateToRow(resolution.rowIndex, displayRowKey(rowKey))
    },
    [phase, historyRef, navigateToRow],
  )

  /** m4-5 pattern for the diff report: destination with the same-source guard. */
  const requestDiffReportDestinationForPanel = useCallback(
    (format: DiffReportFormat) =>
      requestDiffReportDestination(format, {
        sourceIdentity: sourceIdentityRef.current ?? undefined,
      }),
    [sourceIdentityRef],
  )

  /**
   * New-dataset reset: drop a staged comparison and any row diff, clear the
   * jump feedback, release the comparison handle, and bump both generation
   * guards so an in-flight stage/run is abandoned.
   */
  const reset = useCallback(() => {
    setComparisonState({ kind: 'none' })
    setDiffRun({ kind: 'idle' })
    setDiffJumpError(null)
    comparisonRef.current = null
    comparisonSeq.current += 1
    diffSeq.current += 1
  }, [])
  useEffect(() => session.registerReset(reset), [session, reset])

  return {
    comparisonState,
    diffRun,
    diffJumpError,
    diffStale,
    handleComparisonFile,
    handleRunDiff,
    handleCancelDiff,
    handleJumpToDiffSample,
    requestDiffReportDestinationForPanel,
  }
}
