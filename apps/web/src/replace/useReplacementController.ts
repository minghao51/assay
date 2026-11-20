// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * D02b — the app-local replacement controller (WF-06 acquisition/preparation).
 *
 * This hook owns the **candidate lifecycle** of a ready-state replacement and
 * nothing else: the intent machine instance (`./machine`), the gesture gate
 * invocation (`./gate`), picker acquisition, candidate preparation against a
 * candidate-local overlay, and the currency checks after every `await`. It
 * returns **commands** (what the composition root may ask for) and
 * **renderable state** (what the shell draws) — no session slot, no engine
 * handle, no history/overlay write.
 *
 * Ownership boundaries (deliberate, and the D02c seam):
 *
 * - **App remains the composition root.** It supplies the ports below and owns
 *   the one irreversible step: `adopt` performs `beginSession()`, republishes
 *   the adopted history/overlay, rebinds the provider, publishes the `ready`
 *   phase and emits `dataset_opened` exactly once. This controller only
 *   *calls* it, exactly once, after the last currency check passes.
 * - **The controller owns its own intent + notice state** (a single React
 *   state slot each, read by the shell). There is no second reducer: the
 *   transitions are the ones `./machine` already defines, and the gate verdict
 *   is the one `./gate` already returns.
 * - **No callback registry.** Every dependency is a named field of
 *   {@link ReplacementControllerParams}, visible at the single call site in
 *   `App.tsx`; the volatile gate readings (`gateModal`, `gridBusy`) are passed
 *   with the gesture that consumes them, because they are render values, not
 *   authorities.
 *
 * Preserved invariants (v5 contract §3.2, §4.3, §4.6, §7):
 *
 * - The picker is invoked **synchronously from the triggering gesture**: the
 *   gate runs first, then `pickFile` is called with no intervening `await`, so
 *   the File System Access transient user activation is still live.
 * - **Every `await` is followed by a currency check** (`isIntentCurrent`):
 *   a superseded intent or a different phase drops the result silently and
 *   never writes the live session (T10).
 * - A candidate is prepared against its **own base and an empty local overlay
 *   box** (A1-1/A1-2); the live `overlayRef` is never captured.
 * - Adoption is guarded by `canAdopt` (step 0) and runs **exactly once**; the
 *   caller's `adopt` port emits `dataset_opened`.
 * - Picker cancel and preparation failure leave **every live session slot
 *   untouched** (T6/T9/T9b) — only notice state changes.
 * - The CSV review is a candidate step of the same intent: the preview is
 *   non-adopting and lives behind the caller's `engine.csvPreview` port; the
 *   abandonment path claims nothing about a release (ADR 0049).
 */
import { useCallback, useRef, useState } from 'react'
import { emptyHistory } from '@assay/domain'
import type { OverlayBase, TransformationHistory } from '@assay/domain'
import { GridViewportModel } from '@assay/grid'
import type { EngineCsvOptions } from '@assay/engine-duckdb'
import type {
  EngineCsvOptionsInput,
  EngineCsvPreviewResult,
  EngineFileSource,
  EngineTableHandle,
} from '@assay/engine-duckdb'
import { pickDataFile } from '@assay/data-sources/browser'
import { detectFormatFromFileName } from '@assay/data-sources/browser'
import type { PickedDataFile, ShowOpenFilePickerOptions } from '@assay/data-sources/browser'
import type { CsvReviewMode } from '../csv/CsvReviewDialog'
import { wireCsvOptions } from '../csv/options'
import { createOverlayAnchor, fileVersionAnchor } from '../edit/overlay-base'
import { openFailureMessage, overlaySnapshot } from '../edit/session'
import type { SourceIdentity } from '../export/save-destination'
import type { EditorReportState } from '../grid/DataGrid'
import type { DuckDbGridProvider } from '../grid/provider'
import type { BottomPanelModules } from '../lib/bottom-panels'
import type { Phase } from '../sessions/types'
import { evaluateReadyGesture } from './gate'
import type { OwnedModal, ReadyGestureBusy, ReadyGestureRefusal } from './gate'
import { NO_REPLACEMENT_INTENT, beginIntent, canAdopt, isIntentCurrent } from './machine'
import type { ReplacementIntent } from './machine'

/**
 * A fully prepared replacement candidate. Every value here is local to the
 * preparation — the candidate's own handle/base/model/provider (whose overlay
 * source is the candidate-local empty box until the caller's `adopt` rebinds
 * it), its parked identity and open source. Nothing in this record references
 * the live session's `historyRef`, `overlayRef`, `phase` or panels.
 */
export interface ReplacementCandidate {
  readonly file: File
  readonly handle: EngineTableHandle
  readonly base: OverlayBase
  readonly model: GridViewportModel
  readonly provider: DuckDbGridProvider
  readonly panels: BottomPanelModules
  readonly identity: SourceIdentity | null
  readonly openSource: { getFile: () => Promise<File> }
}

/**
 * What the next ready-state replacement gesture will do once the gate passes.
 * `open` is the shipped candidate open; `review` is the CSV review. The Open
 * control always states its own path, so a remembered review can never turn a
 * plain Open into a review — only the guard hand-off (T5) and the failure
 * retry (C11) reuse the remembered path.
 */
export type ReplacementPath = 'open' | 'review'

/**
 * The CSV review surface's controller-owned inputs. The option FORM and the
 * preview payload stay inside `CsvReviewDialog`; this hand-off keeps only what
 * adoption needs, so the review cannot write session state.
 */
export interface CsvReviewHandoff {
  readonly mode: CsvReviewMode
  readonly file: File
  readonly identity: SourceIdentity | null
  /** The phase the gesture started from — WF-06's currency capture. */
  readonly startPhase: Phase
  /** The WF-06 intent sequence the review belongs to. */
  readonly intentSeq: number
}

/**
 * One-shot hand-off into the single open chain (an idle review adoption, or a
 * non-.csv pick from the review control). Returned by `adoptCsvReview` when
 * the caller — not this controller — owns the idle open chain.
 */
export interface CsvAdoptionHandoff {
  readonly file: File
  readonly identity: SourceIdentity | null
  readonly options: EngineCsvOptions | undefined
}

/**
 * What the caller's exactly-once `adopt` port reports back. `faulted` means
 * the reset it ran could not complete, so the generation was invalidated and
 * the recovery frame was published instead of a `ready` phase (C03b).
 */
export type AdoptionOutcome = 'adopted' | 'faulted'

/** The candidate's grid pair, built by the caller's `createCandidateGrid`. */
export interface CandidateGrid {
  readonly provider: DuckDbGridProvider
  readonly model: GridViewportModel
}

/**
 * The engine operations candidate preparation needs. A structural subset of
 * the app's one engine client, so the composition root passes the client
 * itself and tests pass a fake — no second client, no wrapper class.
 */
export interface ReplacementEnginePort {
  open(source: EngineFileSource, options?: EngineCsvOptionsInput): Promise<EngineTableHandle>
  schema(handle: EngineTableHandle): Promise<readonly { name: string; type: string }[]>
  rowCount(handle: EngineTableHandle): Promise<number>
  csvPreview(
    source: EngineFileSource,
    options?: EngineCsvOptionsInput,
    sampleRows?: number,
  ): Promise<EngineCsvPreviewResult>
}

/**
 * The synchronous gate readings a gesture carries. Both are render values in
 * the composition root (the owned-modal arbitration and the grid's filter/sort
 * epoch), so they are read at the gesture, never cached here.
 */
export interface ReplacementGestureReadings {
  readonly gateModal: OwnedModal | null
  readonly gridBusy: ReadyGestureBusy | null
}

export interface ReplacementGateOptions {
  /** `false` for T5/C11, which re-enter `choosing` with the guard already gone. */
  readonly respectDirtyGuard: boolean
  /** The path this gesture takes; omitted keeps the remembered path. */
  readonly path?: ReplacementPath
}

export interface ReplacementControllerParams {
  /** Live phase mirror (the currency check's phase identity). */
  readonly phaseRef: { readonly current: Phase }
  /** A2: the App-owned editor-state authority (G3). */
  readonly editorStateRef: { readonly current: EditorReportState }
  /** S-A2-2: commits in flight (G4). */
  readonly mutationStateRef: { readonly current: number }
  /** S-A2-4: the aggregate cast-pending set (G4). */
  readonly castPendingColumnsRef: { readonly current: ReadonlySet<string> }
  /** The settled active history (G6). */
  readonly historyRef: { readonly current: TransformationHistory }
  /** The picker entry point; called synchronously from the gesture. */
  readonly pickFile: typeof pickDataFile
  /** The engine operations (`engineClient` in the App). */
  readonly engine: ReplacementEnginePort
  /** Builds the candidate's provider + model on its own overlay source. */
  readonly createCandidateGrid: (input: {
    readonly handle: EngineTableHandle
    readonly overlaySource: () => ReturnType<typeof overlaySnapshot>
  }) => CandidateGrid
  /** au3-12: resolve the below-fold panels before the `ready` render. */
  readonly preloadPanels: () => Promise<BottomPanelModules>
  /**
   * The composition root's exactly-once adoption (T8). Performs the session
   * reset, republishes history/overlay, rebinds the provider, publishes the
   * `ready` phase and emits `dataset_opened`. Called at most once per
   * candidate, and only after `canAdopt`.
   */
  readonly adopt: (candidate: ReplacementCandidate) => AdoptionOutcome
}

export interface ReplacementController {
  /** The intent machine instance (render + G2/adoption authority). */
  readonly intent: ReplacementIntent
  /** T6/C8: the chooser was dismissed; the live session is unchanged. */
  readonly pickerWasCancelled: boolean
  /** T9/T9b/C10/C14: the candidate failed; only the notice renders. */
  readonly replacementFailure: { readonly cause: string; readonly detail: string } | null
  /** C12: a ready gesture arrived while another intent is active. */
  readonly busyNotice: boolean
  /** C13: a G3 refusal; cleared when the editor closes. */
  readonly draftNotice: boolean
  /** EW-03I-b: the mounted CSV review candidate, if any. */
  readonly csvReview: CsvReviewHandoff | null
  /** "You stopped reviewing" — which mode abandoned. */
  readonly csvReviewStopped: CsvReviewMode | null
  /** The single ready-state entry point (G1–G6). */
  readonly beginGesture: (
    readings: ReplacementGestureReadings,
    options: ReplacementGateOptions,
  ) => void
  /** T5: the guard's destructive action re-enters `choosing`. */
  readonly chooseFromGuard: (readings: ReplacementGestureReadings) => void
  /** C11: retry re-enters `choosing`; never the destroy-first flow. */
  readonly retry: (readings: ReplacementGestureReadings) => void
  /** T3: end the intent without touching the live session. */
  readonly endIntent: () => void
  /** IC-01: the editor closed, so C13 may clear. */
  readonly noteEditorClosed: () => void
  /**
   * Adoption of a reviewed CSV. Returns the idle hand-off when the caller owns
   * the open chain (no live session), else `null` after preparing the
   * candidate through the guarded ready path.
   */
  readonly adoptCsvReview: (
    handoff: CsvReviewHandoff,
    options: EngineCsvOptions,
  ) => CsvAdoptionHandoff | null
  /** Abandonment (ADR 0049 item 7): drop the candidate, say "stopped". */
  readonly stopCsvReview: (handoff: CsvReviewHandoff) => void
  /** Mount a review candidate acquired by the caller's (idle) picker chain. */
  readonly presentCsvReview: (handoff: CsvReviewHandoff) => void
  /** Clear the abandonment copy before a new open attempt. */
  readonly clearReviewStopped: () => void
  /** The non-adopting CSV preview call (stable for the dialog's effect). */
  readonly previewCsv: (
    source: EngineFileSource,
    options?: EngineCsvOptionsInput,
    sampleRows?: number,
  ) => Promise<EngineCsvPreviewResult>
}

/**
 * G3's per-kind focus chain (v5 §3.2.1): the boolean editor's own testid, then
 * the text/number/temporal input, then the shared editor container, then the
 * roving row, then the Open control. Never `<body>`: the Open control is always
 * connected. The refusal only moves focus — it never commits, cancels or types
 * anything.
 */
function focusDraftRefusal(): void {
  const selectors = [
    '[data-testid="grid-editor-boolean"]',
    '[data-testid="grid-editor-input"]',
    '[data-testid="grid-cell-editor"]',
    '[data-testid="grid-viewport"] [data-testid="grid-row"][tabindex="0"]',
    '[data-testid="open-button"]',
  ]
  for (const selector of selectors) {
    const target = document.querySelector<HTMLElement>(selector)
    if (target === null) continue
    target.focus()
    return
  }
}

/**
 * Ask the picker for one file and retain the FSA handle it returned. The
 * handle is the ground truth for the export same-source guard (as in the
 * legacy open flow); structural fakes may omit it. `pickFile` is called
 * immediately — no `await` may precede it (transient user activation).
 */
function pickDataFileWithCapture(
  pickFile: typeof pickDataFile,
  openCapture: { handle: FileSystemFileHandle | null },
): Promise<PickedDataFile | null> {
  return pickFile({
    showOpenFilePicker: async (options: ShowOpenFilePickerOptions) => {
      const handles = await showOpenFilePicker(options)
      openCapture.handle = handles[0] ?? null
      return handles
    },
  })
}

/**
 * WF-06 ready-state replacement controller (D02b). See the module doc for the
 * ownership boundary; every write below is either this hook's own renderable
 * state, or a call through the caller's `adopt` port.
 */
export function useReplacementController(
  params: ReplacementControllerParams,
): ReplacementController {
  const {
    phaseRef,
    editorStateRef,
    mutationStateRef,
    castPendingColumnsRef,
    historyRef,
    pickFile,
    engine,
    createCandidateGrid,
    preloadPanels,
    adopt,
  } = params

  /** The intent is App-local state, separate from `Phase` (v5 §4.1). */
  const [intent, setIntentState] = useState<ReplacementIntent>(NO_REPLACEMENT_INTENT)
  /**
   * Synchronous mirror of the intent. The gate (G2), the guard-close→choosing
   * transition (T5) and the adoption step 0 all need the CURRENT intent, not
   * the value captured by the render that created the handler.
   */
  const intentRef = useRef<ReplacementIntent>(NO_REPLACEMENT_INTENT)
  /** The sequence authority (C2): bumped when an intent is entered. */
  const intentSeqRef = useRef(0)
  const setIntent = useCallback((next: ReplacementIntent) => {
    intentRef.current = next
    setIntentState(next)
  }, [])
  /** T6: the picker was dismissed; the live session is unchanged (C8). */
  const [pickerWasCancelled, setPickerWasCancelled] = useState(false)
  /** T9/T9b: the candidate failed; only C10 + C14 render (live session kept). */
  const [replacementFailure, setReplacementFailure] = useState<{
    readonly cause: string
    readonly detail: string
  } | null>(null)
  /** C12 — a ready gesture arrived while another intent is active. */
  const [busyNotice, setBusyNotice] = useState(false)
  /** C13 — G3 refusal; clears when the editor closes (the mirror callback). */
  const [draftNotice, setDraftNotice] = useState(false)
  /** EW-03I-b — the mounted CSV review candidate (never a `Phase`). */
  const [csvReview, setCsvReview] = useState<CsvReviewHandoff | null>(null)
  /** "You stopped reviewing" — abandonment copy, cleared by the next gesture. */
  const [csvReviewStopped, setCsvReviewStopped] = useState<CsvReviewMode | null>(null)
  /**
   * The path the user chose for the next replacement gesture (EW-03D §3):
   * plain open, or the CSV review. Remembered across the dirty guard (T5) and
   * the failure retry (C11) so a review gesture stays a review gesture.
   */
  const desiredPathRef = useRef<ReplacementPath>('open')

  /**
   * Clear the GESTURE-scoped notices a newer gesture (or a finished intent)
   * supersedes. C15/C16 are deliberately absent: they follow their own live
   * observables in the editing session and no gesture may clear them early.
   */
  const clearReplacementNotices = useCallback((): void => {
    setPickerWasCancelled(false)
    setReplacementFailure(null)
    setBusyNotice(false)
    setDraftNotice(false)
    setCsvReviewStopped(null)
  }, [])

  /** End the current intent without touching the live session. */
  const endIntent = useCallback((): void => {
    setIntent(NO_REPLACEMENT_INTENT)
    setBusyNotice(false)
  }, [setIntent])

  /**
   * Enter one in-flight intent: bump the sequence authority first, then publish
   * the intent carrying that sequence (C2). Returns the sequence the async
   * chain must keep comparing against `intentSeqRef.current`.
   */
  const enterIntent = useCallback(
    (kind: 'guard' | 'choosing' | 'opening-candidate'): number => {
      intentSeqRef.current += 1
      const seq = intentSeqRef.current
      setIntent(beginIntent(kind, seq))
      return seq
    },
    [setIntent],
  )

  /** One refusal: a value-free notice (or the existing idle/status path). */
  const applyReplacementRefusal = useCallback((reason: ReadyGestureRefusal): void => {
    switch (reason) {
      case 'modal':
        // Existing arbitration: the opener is disabled while another owned
        // surface is open, so this path is defensive only — no notice.
        return
      case 'intent':
        setBusyNotice(true)
        return
      case 'editor':
        setDraftNotice(true)
        focusDraftRefusal()
        return
      case 'settling':
      case 'cast':
        // C15/C16 are already rendered because their observable is live; a
        // refusal adds nothing and (critically) never owns their lifetime.
        return
      case 'busy':
        // G5 reuses the grid's existing filter/sort busy status; no new copy.
        return
    }
  }, [])

  /**
   * T9/T9b: the candidate failed before adoption. The live session keeps every
   * slot (only the notice state changes) and one retained candidate table may
   * exist in this worker (ADR 0047 — no release primitive; never claimed
   * leak-free). The C10 cause is the classified, value-free sentence; the raw
   * diagnostic is parked for the collapsed C14 block only.
   */
  const failReplacement = useCallback(
    (error: unknown): void => {
      endIntent()
      setReplacementFailure({
        cause: openFailureMessage(error, error instanceof Error ? error.name : undefined),
        detail: error instanceof Error ? error.message : String(error),
      })
    },
    [endIntent],
  )

  /**
   * T7–T9b — prepare the candidate against its OWN base and an EMPTY local
   * overlay box (A1-1/A1-2). The live session's refs, phase, provider, history
   * and panels are untouched for the whole preparation. A1's stop rule applies:
   * if a candidate read could reach `overlayRef` this would be a data-correctness
   * defect, not a cosmetic one — the closure below references no App ref.
   */
  const prepareReplacementCandidate = useCallback(
    (input: {
      readonly file: File
      readonly identity: SourceIdentity | null
      readonly startPhase: Phase
      /**
       * EW-03I-b: the reviewed CSV option set, when this candidate came from
       * the CSV review. It is passed straight to `engine/open` — a fresh open
       * carrying the reviewed options (ADR 0049 acceptance resolution 5), never
       * a promotion and never a second `TableRegistry` writer. `undefined` for
       * every other path, which keeps that request byte-identical.
       */
      readonly csvOptions?: EngineCsvOptions
    }): void => {
      const { file, identity, startPhase, csvOptions } = input
      const seq = enterIntent('opening-candidate')
      void (async () => {
        try {
          const source = { name: file.name, getFile: () => Promise.resolve(file) }
          // Wire shape only: a fresh plain record (structured clone), which the
          // client and the worker each re-validate through the same total
          // `parseCsvOptions` — no trust crosses the boundary. No reviewed
          // options ⇒ the exact single-argument call this chain always made.
          const reviewed = wireCsvOptions(csvOptions ?? {})
          const handle =
            reviewed === undefined ? await engine.open(source) : await engine.open(source, reviewed)
          if (!isIntentCurrent(intentSeqRef.current, seq, phaseRef.current, startPhase)) return
          const candidateSchema = await engine.schema(handle)
          if (!isIntentCurrent(intentSeqRef.current, seq, phaseRef.current, startPhase)) return
          const candidateRowCount = await engine.rowCount(handle)
          if (!isIntentCurrent(intentSeqRef.current, seq, phaseRef.current, startPhase)) return
          const candidateBase: OverlayBase = {
            baseAnchor: fileVersionAnchor({ size: file.size, lastModified: file.lastModified }),
            overlayAnchor: createOverlayAnchor(),
            columns: candidateSchema.map((column) => ({
              name: column.name,
              type: column.type,
            })),
            baseRowCount: candidateRowCount,
          }
          // A1-1: candidate-local box, built from the CANDIDATE's base. No live
          // ref, history or phase value is captured (A1-2).
          const candidateOverlayBox = { current: overlaySnapshot(candidateBase, emptyHistory()) }
          const candidateGrid = createCandidateGrid({
            handle,
            overlaySource: () => candidateOverlayBox.current,
          })
          await candidateGrid.model.load()
          if (!isIntentCurrent(intentSeqRef.current, seq, phaseRef.current, startPhase)) return
          const panels = await preloadPanels()
          if (!isIntentCurrent(intentSeqRef.current, seq, phaseRef.current, startPhase)) return
          // Step 0 (v5 §4.3): the only adoption guard. A refusal writes nothing.
          if (
            !canAdopt({
              intent: intentRef.current,
              currentSeq: intentSeqRef.current,
              phase: phaseRef.current,
              capturedPhase: startPhase,
            })
          ) {
            return
          }
          // The one irreversible step is the caller's. Exactly once: this chain
          // runs once per candidate and returns immediately afterwards.
          const outcome = adopt({
            file,
            handle,
            base: candidateBase,
            model: candidateGrid.model,
            provider: candidateGrid.provider,
            panels,
            identity,
            openSource: { getFile: () => Promise.resolve(file) },
          })
          // Step 9: the intent ends last. A faulted reset has already published
          // the recovery frame, so the intent ends too — never a stuck
          // `opening-candidate` over an abandoned generation (C03b).
          clearReplacementNotices()
          setIntent(NO_REPLACEMENT_INTENT)
          if (outcome === 'faulted') intentSeqRef.current += 1
        } catch (error) {
          if (!isIntentCurrent(intentSeqRef.current, seq, phaseRef.current, startPhase)) return
          failReplacement(error)
        }
      })()
    },
    [
      enterIntent,
      engine,
      createCandidateGrid,
      preloadPanels,
      adopt,
      phaseRef,
      clearReplacementNotices,
      setIntent,
      failReplacement,
    ],
  )

  /**
   * T1/T5/T6/T7 — acquire and prepare a candidate while the live session stays
   * live. The picker is invoked synchronously from the triggering gesture (the
   * File System Access picker needs the transient user activation), so the gate
   * above it must already have run; nothing here awaits before it.
   */
  const acquireReplacementCandidate = useCallback(
    (startPhase: Phase): void => {
      const seq = enterIntent('choosing')
      const openCapture: { handle: FileSystemFileHandle | null } = { handle: null }
      void (async () => {
        let picked: PickedDataFile | null
        try {
          picked = await pickDataFileWithCapture(pickFile, openCapture)
        } catch (error) {
          if (!isIntentCurrent(intentSeqRef.current, seq, phaseRef.current, startPhase)) return
          failReplacement(error)
          return
        }
        if (!isIntentCurrent(intentSeqRef.current, seq, phaseRef.current, startPhase)) return
        if (picked === null) {
          // T6: chooser dismissed. No reset, no phase write — the live session
          // is byte-identical, and C8 says so.
          endIntent()
          setPickerWasCancelled(true)
          return
        }
        const identity: SourceIdentity | null =
          openCapture.handle === null
            ? null
            : { isSameEntry: openCapture.handle.isSameEntry.bind(openCapture.handle) }
        let file: File
        try {
          file = await picked.source.getFile()
        } catch (error) {
          if (!isIntentCurrent(intentSeqRef.current, seq, phaseRef.current, startPhase)) return
          failReplacement(error)
          return
        }
        if (!isIntentCurrent(intentSeqRef.current, seq, phaseRef.current, startPhase)) return
        prepareReplacementCandidate({ file, identity, startPhase })
      })()
    },
    [enterIntent, pickFile, phaseRef, failReplacement, endIntent, prepareReplacementCandidate],
  )

  /**
   * The ready-state review acquisition (T1/T5/T6/T7 shape): the picker runs
   * synchronously from the gesture, then a CSV pick opens the review instead of
   * preparing a candidate. A cancelled chooser is T6 (C8: nothing opened,
   * session unchanged); a non-CSV pick falls through to the ordinary candidate
   * preparation unchanged.
   */
  const acquireCsvReview = useCallback(
    (startPhase: Phase): void => {
      const seq = enterIntent('choosing')
      const openCapture: { handle: FileSystemFileHandle | null } = { handle: null }
      void (async () => {
        let picked: PickedDataFile | null
        try {
          picked = await pickDataFileWithCapture(pickFile, openCapture)
        } catch (error) {
          if (!isIntentCurrent(intentSeqRef.current, seq, phaseRef.current, startPhase)) return
          failReplacement(error)
          return
        }
        if (!isIntentCurrent(intentSeqRef.current, seq, phaseRef.current, startPhase)) return
        if (picked === null) {
          endIntent()
          setPickerWasCancelled(true)
          return
        }
        const identity: SourceIdentity | null =
          openCapture.handle === null
            ? null
            : { isSameEntry: openCapture.handle.isSameEntry.bind(openCapture.handle) }
        let file: File
        try {
          file = await picked.source.getFile()
        } catch (error) {
          if (!isIntentCurrent(intentSeqRef.current, seq, phaseRef.current, startPhase)) return
          failReplacement(error)
          return
        }
        if (!isIntentCurrent(intentSeqRef.current, seq, phaseRef.current, startPhase)) return
        if (detectFormatFromFileName(file.name) !== 'csv') {
          prepareReplacementCandidate({ file, identity, startPhase })
          return
        }
        setCsvReviewStopped(null)
        setCsvReview({ mode: 'replace', file, identity, startPhase, intentSeq: seq })
      })()
    },
    [enterIntent, pickFile, phaseRef, failReplacement, endIntent, prepareReplacementCandidate],
  )

  /**
   * The single ready-state entry point (G1–G6). `readings.gateModal` is the
   * owned-modal value the gate sees — `openModal` for a fresh gesture, or the
   * non-replace value when the guard itself is closing into choosing (T5),
   * where the modal is already gone so G1 must pass. `respectDirtyGuard` is
   * false for T5/C11, which re-enter `choosing` directly.
   */
  const beginGesture = useCallback(
    (readings: ReplacementGestureReadings, options: ReplacementGateOptions): void => {
      const livePhase = phaseRef.current
      if (livePhase.kind !== 'ready') return
      if (options.path !== undefined) desiredPathRef.current = options.path
      const wantedPath = desiredPathRef.current
      // v5 §3.2: the gate runs FIRST — before any dialog, picker, await or state
      // write. Notices are cleared only once the verdict is known; a refusal
      // then sets its own notice, so a stale notice can never be cleared by a
      // gesture the gate refused for another reason, and the gate never
      // observes a render it caused.
      const verdict = evaluateReadyGesture({
        openModal: readings.gateModal,
        intent: intentRef.current,
        editorOpen: editorStateRef.current.open,
        mutations: mutationStateRef.current,
        castPendingCount: castPendingColumnsRef.current.size,
        gridBusy: readings.gridBusy,
        history: historyRef.current,
      })
      clearReplacementNotices()
      if (verdict.kind === 'refuse') {
        applyReplacementRefusal(verdict.reason)
        return
      }
      if (options.respectDirtyGuard && verdict.dirty) {
        enterIntent('guard')
        return
      }
      if (wantedPath === 'review') acquireCsvReview(livePhase)
      else acquireReplacementCandidate(livePhase)
    },
    [
      phaseRef,
      editorStateRef,
      mutationStateRef,
      castPendingColumnsRef,
      historyRef,
      clearReplacementNotices,
      applyReplacementRefusal,
      enterIntent,
      acquireCsvReview,
      acquireReplacementCandidate,
    ],
  )

  /**
   * T5 — the guard's destructive action re-enters `choosing`. `ReplaceGuard`
   * closes the native dialog element synchronously before it calls this
   * handler, and the intent drops to `none` first so G2 passes for this one
   * transition; `readings.gateModal` still refuses if another owned surface is
   * open.
   */
  const chooseFromGuard = useCallback(
    (readings: ReplacementGestureReadings): void => {
      if (phaseRef.current.kind !== 'ready') return
      setIntent(NO_REPLACEMENT_INTENT)
      beginGesture(readings, { respectDirtyGuard: false })
    },
    [beginGesture, phaseRef, setIntent],
  )

  /** C11 — retry re-enters `choosing`; it is never the destroy-first flow. */
  const retry = useCallback(
    (readings: ReplacementGestureReadings): void => {
      beginGesture(readings, { respectDirtyGuard: false })
    },
    [beginGesture],
  )

  /** IC-01: the render-only editor mirror's only job — clearing C13. */
  const noteEditorClosed = useCallback((): void => {
    setDraftNotice(false)
  }, [])

  /**
   * Adoption of a reviewed CSV — the only irreversible step, and the only one
   * that ever writes a session. Idle: return the one-shot hand-off so the
   * composition root can enter its single open chain. Ready: the existing
   * guarded preparation, which ends in the caller's exactly-once adoption.
   */
  const adoptCsvReview = useCallback(
    (handoff: CsvReviewHandoff, options: EngineCsvOptions): CsvAdoptionHandoff | null => {
      setCsvReviewStopped(null)
      setCsvReview(null)
      if (handoff.mode === 'idle') {
        return { file: handoff.file, identity: handoff.identity, options }
      }
      // Defensive (the modal owns the shell, so no gesture can supersede it):
      // if the intent or the phase moved, open nothing and say so.
      if (
        !isIntentCurrent(
          intentSeqRef.current,
          handoff.intentSeq,
          phaseRef.current,
          handoff.startPhase,
        )
      ) {
        endIntent()
        setCsvReviewStopped('replace')
        return null
      }
      prepareReplacementCandidate({
        file: handoff.file,
        identity: handoff.identity,
        startPhase: handoff.startPhase,
        csvOptions: options,
      })
      return null
    },
    [phaseRef, endIntent, prepareReplacementCandidate],
  )

  /**
   * Abandonment (ADR 0049 item 7). Drops the candidate, bumps the sequence
   * authority so a late preview result can never be adopted, ends any intent,
   * and says "stopped reviewing" — never "aborted", and never that a preview
   * slot was released. There is no host-reachable release op, so one staged
   * preview stays retained until the next preview, an open, or `engine/dispose`.
   */
  const stopCsvReview = useCallback(
    (handoff: CsvReviewHandoff): void => {
      intentSeqRef.current += 1
      setCsvReview(null)
      endIntent()
      setPickerWasCancelled(false)
      setReplacementFailure(null)
      setCsvReviewStopped(handoff.mode)
    },
    [endIntent],
  )

  /** Mount a review candidate acquired by the caller's own (idle) chain. */
  const presentCsvReview = useCallback((handoff: CsvReviewHandoff): void => {
    setCsvReviewStopped(null)
    setCsvReview(handoff)
  }, [])

  const clearReviewStopped = useCallback((): void => {
    setCsvReviewStopped(null)
  }, [])

  /** The engine's non-adopting preview call, stable for the dialog's effect. */
  const previewCsv = useCallback<ReplacementController['previewCsv']>(
    (source, options, sampleRows) => engine.csvPreview(source, options, sampleRows),
    [engine],
  )

  return {
    intent,
    pickerWasCancelled,
    replacementFailure,
    busyNotice,
    draftNotice,
    csvReview,
    csvReviewStopped,
    beginGesture,
    chooseFromGuard,
    retry,
    endIntent,
    noteEditorClosed,
    adoptCsvReview,
    stopCsvReview,
    presentCsvReview,
    clearReviewStopped,
    previewCsv,
  }
}
