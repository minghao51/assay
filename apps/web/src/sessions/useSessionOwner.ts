// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * D02c — the app-local **session owner**: one explicit boundary for the dataset
 * session's generation, its published phase and its one irreversible step.
 *
 * Before D02c the composition root (`App`) both owned and *wrote* the session
 * boundary inline: it created the reset registry, called `beginSession()` in
 * three places, hand-published `historyRef`/`overlayRef`, wrote the `phase`
 * mirror, emitted `dataset_opened`, and captured the export snapshot inside the
 * editing session. Six pieces of state had no single named owner. This module
 * makes one.
 *
 * ## What this hook owns (and nothing else)
 *
 * - **The reset registry** (`useDatasetSession`) — the session token and the
 *   per-domain reset list. This hook is the ONLY caller of `beginSession()`, so
 *   every transition that invalidates the generation (open, cancel, adoption)
 *   runs through one place. Registrants keep their own bodies: each per-domain
 *   reset clears the state its own hook owns (`useEditingSession`,
 *   `useValidationSession`, `usePipelineSession`, `useDiffSession`, and the two
 *   App-owned UI slots). "One owner per reset body, one caller for the list."
 * - **`phase`** (and its synchronous `phaseRef` mirror) — the render-frame
 *   authority. Every phase transition (`idle`, `opening`, `error`, `ready`) is
 *   written only by a command below; `App` reads `phase`/`phaseRef` and never
 *   calls a raw setter.
 * - **`sessionFault`** — the C03b fail-closed frame's value-free fault list.
 * - **The adopted source slots** — `openSourceRef` (ug-9/R-15: the open dataset
 *   a pipeline node may bind with no picker) and `sourceIdentityRef` (the
 *   export same-source identity). Both are published only by a ready frame.
 * - **`panelModules`** — au3-12's resolved below-fold panels, published before
 *   the `ready` render.
 * - **The one irreversible step**: `adopt()` performs the entire adoption
 *   (steps 1–8 below) and `publishReady()` the equivalent for the legacy open
 *   chain, so `dataset_opened` has exactly one emitter.
 * - **The export-in-flight snapshot**: `runExport()` freezes the exact overlay
 *   the grid is showing, together with the live handle, in one synchronous
 *   step, then hands that frozen pair to the engine op. A later edit or
 *   adoption can therefore never change what an export in flight exported
 *   (ADR 0012).
 *
 * ## What this hook deliberately does NOT do
 *
 * - No second reducer and no session store: the values above are ordinary
 *   React state in the composition root's own fiber (this hook is called by
 *   `App`), and the replacement intent machine (`replace/machine`) and the
 *   reset registry (`session-reset`) stay the modules that already own their
 *   transitions.
 * - No callback registry: every dependency is a named field of
 *   {@link SessionOwnerPorts} or of the per-transition {@link SessionGridPorts}
 *   passed by `App` at the single call site.
 * - It never hands out a mutable `historyRef`/`overlayRef`. History and overlay
 *   belong to `useEditingSession`; the owner asks that owner to *publish* an
 *   adopted base (`publishEmptyBase`) and to *read* the live snapshot
 *   (`snapshotOverlay`) through named commands.
 *
 * ## Why the grid publication ports arrive per transition
 *
 * `useEditingSession` needs the `phase` this hook owns (it folds the base and
 * drives `model.refresh()`), so it can only be constructed *after* this hook —
 * which means the owner cannot receive that hook's commands as construction
 * ports without a mutable port slot (exactly the registry this design forbids).
 * The two publication commands therefore travel as an explicit
 * {@link SessionGridPorts} argument on the two transitions that need them
 * (`publishReady`, `adopt`) and on `runExport`. There are three call sites, all
 * in `App`, and all pass the same memoized object.
 *
 * ## State ownership — exactly one owner each (D02c)
 *
 * | State                         | Owner                                   | Written only by                                                                                |
 * | ----------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------- |
 * | session token + reset registry | this hook                               | `beginOpen` / `cancelOpen` / `adopt` (the three `beginSession()` callers)                        |
 * | `phase` (+ `phaseRef`)        | this hook                               | the phase commands below (`beginOpen`, `cancelOpen`, `publishIdle`, `publishError`, ready frame) |
 * | `sessionFault`                | this hook                               | `beginOpen` / `cancelOpen` / `adopt`                                                            |
 * | open source + source identity | this hook                               | a ready frame (`publishReady` / `adopt`)                                                        |
 * | resolved `panelModules`       | this hook                               | a ready frame                                                                                   |
 * | history (state + `historyRef`) | `useEditingSession`                     | its own `activateHistory` / reset / `publishEmptyBase` command                                  |
 * | overlay (`overlayRef`, revision) | `useEditingSession`                   | the same three; read through `snapshotOverlay`                                                  |
 * | replacement token + intent    | `useReplacementController`              | its own `machine` transitions (`intentRef` / `intentSeqRef`)                                    |
 * | report revision (run stamp)   | `useValidationSession` / `useDiffSession` | that run's own start; the counter is `useEditingSession`'s `overlayRevision`                  |
 * | export-in-flight snapshot     | this hook (`runExport`)                 | one frozen `{ handle, overlay }` per export call                                                |
 * | app-local request slots       | `App`                                   | `App` writes; this hook decides when they are retired                                           |
 *
 * ## Preserved invariants (D02/D02c acceptance)
 *
 * - Exactly-once adoption, exact adoption step order (1 reset → 2–3 publish →
 *   4 rebind → 5 identity/open source → 6 panels → 7 ready + retire → 8
 *   telemetry), and exactly-once `dataset_opened` on both ready paths.
 * - Stale candidates and superseded open chains cannot publish: every ready
 *   publication is token-guarded, and `adopt` reports `faulted`/`adopted` from
 *   the same call that ran the reset.
 * - C03b fail closed: a faulted reset never publishes a `ready` phase, never
 *   rebinds the candidate, never emits telemetry, and surfaces the session-fault
 *   frame instead. Reset callbacks remain synchronous and isolated.
 * - No extra engine call: this module issues no engine open/preview/query/fetch.
 *   `runExport` forwards to the injected export op exactly once per call.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { OverlayBase } from '@assay/domain'
import type {
  EngineExportFormat,
  EngineExportResult,
  EngineOverlay,
  EngineTableHandle,
} from '@assay/engine-duckdb'
import type { GridViewportModel } from '@assay/grid'
import { bucketColumnCount, bucketRowCount, bucketSize } from '@assay/telemetry'
import type { SourceIdentity } from '../export/save-destination'
import type { DuckDbGridProvider } from '../grid/provider'
import type { BottomPanelModules } from '../lib/bottom-panels'
import { formatKindFromName, reasonCodeFromError } from '../telemetry/emit'
import type { WebTelemetryRuntime } from '../telemetry/runtime'
import { useDatasetSession } from './session-reset'
import type { DatasetSession, SessionResetFault } from './session-reset'
import type { Phase } from './types'

/**
 * The grid publication ports a session transition needs. They are commands of
 * the **history/overlay owner** (`useEditingSession`), not its mutable refs:
 * the owner asks for a publication or a snapshot, it never writes another
 * module's state.
 */
export interface SessionGridPorts {
  /**
   * Publish `base` as the adopted session's empty history + overlay. Called
   * immediately after a clean reset, i.e. the render state is already the
   * reset's empty history, so this writes the two authoritative refs only.
   */
  readonly publishEmptyBase: (base: OverlayBase) => void
  /**
   * The exact overlay the grid is showing for `base` (the published ref when it
   * belongs to that base, else the pure fold). Used to rebind a provider and to
   * freeze an export's in-flight snapshot.
   */
  readonly snapshotOverlay: (base: OverlayBase) => EngineOverlay
}

/**
 * One fully prepared session frame. Both ready paths produce this shape:
 * the legacy open chain (after its picker/engine awaits) and the replacement
 * controller's candidate (`ReplacementCandidate` is structurally this).
 */
export interface AdoptedSession {
  /** The opened file; read for format/size only — never rendered or logged. */
  readonly file: File
  readonly handle: EngineTableHandle
  /** Immutable base metadata for the editing session (ADR 0011/0012). */
  readonly base: OverlayBase
  readonly model: GridViewportModel
  readonly provider: DuckDbGridProvider
  /** au3-12: below-fold panels, published before the `ready` render. */
  readonly panels: BottomPanelModules
  /** Export same-source identity (FSA opens only; `null` otherwise). */
  readonly identity: SourceIdentity | null
  /** ug-9/R-15: the one-shot source a pipeline node may bind without a picker. */
  readonly openSource: { getFile: () => Promise<File> }
}

/**
 * What one exactly-once adoption reported. `faulted` means the reset could not
 * complete (C03b), so the generation was invalidated and the recovery frame was
 * published instead of a `ready` phase.
 */
export type SessionAdoptionOutcome = 'adopted' | 'faulted'

/** What `beginOpen()` did: started a guarded chain, or fail-closed. */
export type SessionOpenStart =
  { readonly kind: 'faulted' } | { readonly kind: 'opening'; readonly token: number }

/** Construction ports: everything the owner needs for its whole lifetime. */
export interface SessionOwnerPorts {
  /** The App-owned telemetry runtime (`dataset_opened`/`_failed` sink). */
  readonly telemetry: WebTelemetryRuntime
  /**
   * Retire the App-owned, session-scoped request slots (record inspector
   * request, SQL request, dispatch error, grid scroll request, export dialog).
   * The owner decides WHEN a previous session's requests stop being valid; App
   * owns WHAT they are.
   */
  readonly retireRequests: () => void
  /** The engine's export op over a frozen overlay (one forward per call). */
  readonly exportView: (
    handle: EngineTableHandle,
    request: { readonly format: EngineExportFormat; readonly overlay: EngineOverlay },
  ) => Promise<EngineExportResult>
}

export interface SessionOwner {
  /** The reset registry + session token, passed to the per-domain hooks. */
  readonly session: DatasetSession
  /** The live render frame. Written only by this hook's commands. */
  readonly phase: Phase
  /** Synchronous mirror of `phase` (drop/shortcut/gesture guards). */
  readonly phaseRef: { readonly current: Phase }
  /** C03b: value-free faults of the last abandoned session, else `null`. */
  readonly sessionFault: readonly SessionResetFault[] | null
  /** ug-9/R-15: the open dataset, published only by a ready frame. */
  readonly openSourceRef: { readonly current: AdoptedSession['openSource'] | null }
  /** m4-5: the export same-source identity, published only by a ready frame. */
  readonly sourceIdentityRef: { readonly current: SourceIdentity | null }
  /** au3-12: below-fold panels resolved for the live ready frame. */
  readonly panelModules: BottomPanelModules | null

  /** The live session token, read at capture time by an async intent. */
  readonly currentToken: () => number
  /** Did the session still have `token` when this ran? (post-await guard) */
  readonly isCurrent: (token: number) => boolean

  /**
   * Start the legacy open chain's session: bump the token, run every registered
   * reset, clear the adopted source slots, retire the previous session's
   * requests and publish `opening`. A faulted reset publishes the recovery
   * frame + `idle` instead and returns `faulted` (the caller must then stop,
   * before its first await).
   */
  readonly beginOpen: () => SessionOpenStart
  /**
   * ug-21 cancel: start a new (empty) session and return to `idle`. There is no
   * engine interrupt, so this is an honest UI reset + token discard.
   */
  readonly cancelOpen: () => void
  /** The picker was dismissed: back to `idle`, nothing opened. */
  readonly publishIdle: () => void
  /**
   * Publish a terminal `error` frame (no telemetry: the caller decides whether
   * the failure is a session-level open failure — see `failOpen`).
   */
  readonly publishError: (error: unknown) => void
  /**
   * Publish the `error` frame for a failed open chain AND the value-free
   * `dataset_open_failed` reason enum. Token-guarded: a superseded chain's
   * failure is dropped instead of overwriting the newer phase.
   */
  readonly failOpen: (token: number, error: unknown) => void

  /**
   * Publish one ready frame for a completed open chain (steps equivalent to
   * adoption 2–8). Returns `false` when `token` is no longer the live session —
   * a superseded chain publishes nothing.
   */
  readonly publishReady: (input: AdoptedSession, token: number, grid: SessionGridPorts) => boolean
  /**
   * T8 — the one irreversible step (v5 §4.3, steps 1–8 in order). Fully
   * synchronous: no `await`, no `model.refresh()`, no second worker, no reopen,
   * no release. Called at most once per prepared candidate.
   */
  readonly adopt: (candidate: AdoptedSession, grid: SessionGridPorts) => SessionAdoptionOutcome

  /**
   * m4-5 export: freeze the exact view on screen for `format` and hand it to
   * the engine's export op. Rejects when no table is open (unchanged copy).
   */
  readonly runExport: (
    format: EngineExportFormat,
    grid: SessionGridPorts,
  ) => Promise<EngineExportResult>
}

/**
 * The session owner. See the module doc for the ownership boundary; call it
 * from the composition root only, before the per-domain session hooks (they
 * take its `phase`/`session`/source slots as ports).
 */
export function useSessionOwner(ports: SessionOwnerPorts): SessionOwner {
  const { telemetry, retireRequests, exportView } = ports

  /**
   * f-1: one reset registry for the whole App lifetime. The token and the reset
   * list are refs-cum-module state in React terms; `useDatasetSession` gives
   * them a stable identity without a `useMemo` dependency discussion.
   */
  const session = useDatasetSession()

  /**
   * The live frame. `phaseRef` is written SYNCHRONOUSLY by the stable
   * `setPhase` below, not by a passive effect (ug-15): a drop that lands in the
   * same task as the click that started an open would otherwise still read
   * `idle` and start a second `beginSession`. `setPhase` is the only writer of
   * either half.
   */
  const [phase, setPhaseState] = useState<Phase>({ kind: 'idle' })
  const phaseRef = useRef(phase)
  const setPhase = useCallback((next: Phase) => {
    phaseRef.current = next
    setPhaseState(next)
  }, [])

  /**
   * C03b fail-closed recovery state: the value-free faults of the last
   * `beginSession()` that could not close/start the session cleanly. Non-null
   * means the current session was abandoned (never published ready) and the
   * recovery frame replaces every ordinary open-flow surface for it. `null` on
   * a clean epoch — the fault is per-invocation and the registry re-runs every
   * callback from scratch.
   */
  const [sessionFault, setSessionFault] = useState<readonly SessionResetFault[] | null>(null)

  /**
   * The adopted source slots. Both are published only by a ready frame and
   * cleared when a new session starts, so nothing from the previous session can
   * be bound (pipeline) or compared (export same-source) in the new one.
   */
  const openSourceRef = useRef<AdoptedSession['openSource'] | null>(null)
  const sourceIdentityRef = useRef<SourceIdentity | null>(null)

  /** au3-12: below-fold panels resolved for the live ready frame. */
  const [panelModules, setPanelModules] = useState<BottomPanelModules | null>(null)

  /**
   * f-1: the owner's own slot clears through the same registry as every
   * per-domain slot (no hand-nulled field in the open flow). Registration order
   * is the owner's first, then App's remaining UI slots, then the session hooks
   * — the registry contract states relative order is not observable (every
   * registrant is a synchronous setter/ref write).
   */
  useEffect(
    () =>
      session.registerReset(() => {
        openSourceRef.current = null
      }),
    [session],
  )

  const currentToken = useCallback((): number => session.tokenRef.current, [session])
  const isCurrent = useCallback(
    (token: number): boolean => session.tokenRef.current === token,
    [session],
  )

  /**
   * Steps 2–3, shared by both ready paths: the adopted base is the session's
   * own, so republish history/overlay AFTER the reset (which nulls both) and
   * before any provider read or rebind. The history/overlay owner performs the
   * write; this hook only decides when.
   */
  const publishAdoptedBase = useCallback((input: AdoptedSession, grid: SessionGridPorts): void => {
    grid.publishEmptyBase(input.base)
  }, [])

  /** Steps 5–8, shared by both ready paths. */
  const publishReadyFrame = useCallback(
    (input: AdoptedSession): void => {
      // 5. The adopted session's identity and bound open source.
      sourceIdentityRef.current = input.identity
      openSourceRef.current = input.openSource
      // 6. Panels resolved during preparation, published before the ready frame.
      setPanelModules(input.panels)
      // 7. Retire the previous session's app-local requests, then publish the
      // ready phase (one render).
      retireRequests()
      setPhase({
        kind: 'ready',
        model: input.model,
        tableId: input.handle.id,
        handle: input.handle,
        base: input.base,
        provider: input.provider,
      })
      // 8. `dataset_opened` — closed enums only, exactly as before D02c. This is
      // the ONLY emitter on both ready paths, so an adopted session and an
      // opened session are counted identically and exactly once.
      telemetry.emit('dataset_opened', {
        dataset_role: 'primary',
        format_kind: formatKindFromName(input.file.name),
        size_bucket: bucketSize(input.file.size),
        row_count_bucket: bucketRowCount(input.base.baseRowCount),
        column_count_bucket: bucketColumnCount(input.base.columns.length),
      })
    },
    [retireRequests, setPhase, telemetry],
  )

  const beginOpen = useCallback((): SessionOpenStart => {
    // A fresh attempt starts from a clean frame: the earlier fault was that
    // invocation's, and a new `beginSession` re-runs every reset from scratch.
    setSessionFault(null)
    // AR-W13: one new dataset session — token bump + every per-domain reset.
    const outcome = session.beginSession()
    // Nothing from the previous session may survive the new generation: its
    // open source is already cleared by the registry reset, and its export
    // identity must not leak into the new session's same-source guard.
    sourceIdentityRef.current = null
    if (outcome.faults.length > 0) {
      // C03b fail closed (S7): the generation is invalidated and every remaining
      // reset was attempted, but the reset is partial, so this session is never
      // published. The caller abandons before its first await — no picker, no
      // engine open, no `dataset_opened`/`dataset_open_failed`.
      setSessionFault(outcome.faults)
      setPhase({ kind: 'idle' })
      return { kind: 'faulted' }
    }
    retireRequests()
    setPhase({ kind: 'opening' })
    return { kind: 'opening', token: outcome.token }
  }, [retireRequests, session, setPhase])

  const cancelOpen = useCallback((): void => {
    const outcome = session.beginSession()
    sourceIdentityRef.current = null
    // C03b: a faulted reset means the generation is invalidated but the reset
    // only partly ran. The normal idle frame would claim a clean close that did
    // not happen, so reach the recovery frame instead — and never the stuck
    // `opening` phase an uncaught throw used to leave behind.
    setSessionFault(outcome.faults.length === 0 ? null : outcome.faults)
    setPhase({ kind: 'idle' })
  }, [session, setPhase])

  const publishIdle = useCallback((): void => {
    setPhase({ kind: 'idle' })
  }, [setPhase])

  /**
   * UG-5: the `errorName` is a closed, value-free identifier the alert needs to
   * classify a `DOMException` (`getFile()` missing/unreadable/refused); the raw
   * message is the technical-detail disclosure only and never telemetry.
   */
  const publishError = useCallback(
    (error: unknown): void => {
      setPhase({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
        errorName: error instanceof Error ? error.name : undefined,
      })
    },
    [setPhase],
  )

  const failOpen = useCallback(
    (token: number, error: unknown): void => {
      // A stale chain must not surface its failure over the newer phase.
      if (session.tokenRef.current !== token) return
      // `dataset_open_failed` (design §2/Appendix C): a closed reason enum only;
      // the error message/stack are never attached (ADR 0025/R3).
      telemetry.emit('dataset_open_failed', {
        dataset_role: 'primary',
        format_kind: 'unknown',
        reason_code: reasonCodeFromError(error),
      })
      publishError(error)
    },
    [publishError, session, telemetry],
  )

  const publishReady = useCallback(
    (input: AdoptedSession, token: number, grid: SessionGridPorts): boolean => {
      // The completed chain belongs to `token` only while it is still the live
      // session: a newer open/cancel/adoption supersedes it and this publishes
      // nothing (AR-W13).
      if (session.tokenRef.current !== token) return false
      publishAdoptedBase(input, grid)
      publishReadyFrame(input)
      return true
    },
    [publishAdoptedBase, publishReadyFrame, session],
  )

  const adopt = useCallback(
    (candidate: AdoptedSession, grid: SessionGridPorts): SessionAdoptionOutcome => {
      // 1. One new dataset session: token bump + every registered reset.
      const outcome = session.beginSession()
      if (outcome.faults.length > 0) {
        // C03b fail closed (S5, assertion 4): the generation is invalidated and
        // every remaining reset was attempted, but a partial reset must never be
        // published as the candidate's `ready` phase. Steps 2–8 are skipped —
        // the candidate is not rebound, not published, and no `dataset_opened`
        // is emitted — and the outcome is the session-fault frame, NOT the
        // per-file `replace-error` copy. The previous session is already gone by
        // contract: its generation was invalidated, so no restoration is
        // claimed.
        setSessionFault(outcome.faults)
        setPhase({ kind: 'idle' })
        return 'faulted'
      }
      // A clean adoption supersedes any earlier fault frame: this is a fresh,
      // fully reset session and nothing of the abandoned one is shown.
      setSessionFault(null)
      // 2–3. Publish the adopted base's empty history/overlay (the reset nulled
      // both), then 4. A1-3: only now may the candidate provider follow the live
      // session's overlay for the ADOPTED base.
      publishAdoptedBase(candidate, grid)
      candidate.provider.rebindOverlaySource(() => grid.snapshotOverlay(candidate.base))
      // 5–8. Source slots, panels, ready frame, `dataset_opened` — one shared
      // publication for both ready paths.
      publishReadyFrame(candidate)
      return 'adopted'
    },
    [publishAdoptedBase, publishReadyFrame, session, setPhase],
  )

  /**
   * m4-5 export. The **in-flight snapshot** is frozen here, in the same
   * synchronous step that reads the live handle: the engine op receives an
   * `EngineOverlay` value, so an edit committed (or a session adopted) while the
   * export runs cannot change what this export exported (ADR 0012). The frozen
   * pair is the exact view on screen at the click, never the source path and
   * never the base view alone.
   */
  const runExport = useCallback(
    (format: EngineExportFormat, grid: SessionGridPorts): Promise<EngineExportResult> => {
      const live = phaseRef.current
      if (live.kind !== 'ready') return Promise.reject(new Error('no table is open'))
      const snapshot = grid.snapshotOverlay(live.base)
      return exportView(live.handle, { format, overlay: snapshot })
    },
    [exportView],
  )

  return {
    session,
    phase,
    phaseRef,
    sessionFault,
    openSourceRef,
    sourceIdentityRef,
    panelModules,
    currentToken,
    isCurrent,
    beginOpen,
    cancelOpen,
    publishIdle,
    publishError,
    failOpen,
    publishReady,
    adopt,
    runExport,
  }
}
