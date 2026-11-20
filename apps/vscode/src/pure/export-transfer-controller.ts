// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The desktop export transfer controller (D03a).
 *
 * It owns exactly one piece of the panel bridge: the chunked
 * `export-request` → `export-ready` → `export-start` → `export-chunk`… →
 * `export-finish` → `export-complete` lifecycle, and the single create-only
 * writer that lifecycle may hold. The bridge (`src/dataset.ts`) still routes
 * webview messages; it hands the five export frames here and injects
 * everything with a side effect:
 *
 *   - `post`               host → webview responses (the panel's postMessage),
 *   - `acquireDestination` the save dialog (or the e2e harness path),
 *   - `createWriter`       the create-only writer factory,
 *   - `sourcePaths`        the files the destination must never alias.
 *
 * No `vscode`, DOM or `node:fs` import appears in this module, so the
 * lifecycle is unit-testable over fakes in the `node` vitest project (and the
 * create-only test binds the same controller to the REAL writer).
 *
 * CONTRACT SOURCES — one owner per fact, no parallel schema:
 *   - frame shape/bounds/correlation: pure `acceptExportFrame` and
 *     `EXPORT_CHUNK_BYTES`/`EXPORT_MAX_BYTES` (`export-transfer.ts`);
 *   - the request's format vocabulary: pure `SAFE_EXPORT_FORMATS`;
 *   - the response vocabulary: pure `ExportHostResponse`.
 * The envelope checks below (`id` 1…64 chars, non-negative safe-integer
 * `generation`) are the pre-existing production ingress checks moved
 * verbatim — the bridge no longer validates export frames anywhere else.
 *
 * INVARIANTS this controller is responsible for (unchanged behaviour unless
 * noted):
 *   1. Nothing is written before the frame is accepted: a malformed, stale,
 *      duplicate, out-of-order or oversized chunk refuses the whole transfer
 *      (cleanup + `export-error`/`export-failed`) and the writer never sees
 *      the bytes.
 *   2. One write in flight at a time — `export-credit` is the only signal that
 *      advances the webview, so a second chunk arriving early refuses.
 *   3. A destination is checked for `file` scheme and source aliasing BEFORE
 *      the writer is created; the writer then re-checks the alias against the
 *      canonical path (B04's acquisition contract is unchanged).
 *   4. At most one owned transfer: a second `export-request` while an
 *      acquisition is pending or a writer is held answers `export-busy`
 *      (previously a second save dialog could open and leak a writer).
 *   5. A duplicate `export-start` for the owned transfer refuses instead of
 *      rewinding `nextSequence`/`nextOffset` (which let replay re-append
 *      bytes); this closes a bounds hole, it does not add vocabulary.
 *   6. Disposal, session change and cancellation cancel the owned transfer:
 *      `dispose()` is terminal, and every in-flight continuation (acquisition,
 *      writer creation, chunk write, finish close) captures the ownership
 *      epoch and re-checks it before committing — a continuation whose epoch
 *      moved (cancelled, superseded, disposed) posts nothing and touches no
 *      writer. `cleanup()` also runs any writer a continuation created after
 *      its epoch moved, so no file leaks (previously such a writer was left
 *      behind). No response is posted after disposal, and a `close()` that
 *      settles after a `cancel` never posts `export-complete`/`export-failed`
 *      for the cancelled transfer or releases a newer one.
 *   7. Delivery is create-only: the controller never opens, truncates or
 *      removes anything itself; it only asks the injected factory and calls
 *      `write`/`close`/`cleanup` on what it was given.
 */
import type { CreateOnlyWriter } from './create-only-writer'
import {
  acceptExportFrame,
  EXPORT_MAX_BYTES,
  SAFE_EXPORT_FORMATS,
  type ExportHostResponse,
  type ExportTransferState,
  type SafeExportFormat,
} from './export-transfer'

/** Envelope bound shared by every correlated host request (unchanged ingress). */
const MAX_ID_LENGTH = 64

/**
 * The destination acquisition outcome. `cancelled` is a normal user outcome
 * (`export-cancelled`); a selection that is not a local file, or that aliases
 * a source, is refused before any writer exists.
 */
export type ExportDestination =
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'selected'; readonly scheme: string; readonly fsPath: string }

/** The explicit host dependencies of the export transfer lifecycle. */
export interface ExportTransferControllerDeps {
  /** Post one host → webview export response. */
  readonly post: (message: ExportHostResponse) => void
  /** Ask the host for a destination for this format (save dialog or harness). */
  readonly acquireDestination: (format: SafeExportFormat) => Promise<ExportDestination>
  /** The create-only writer factory (production: `createOnlyWriter`). */
  readonly createWriter: (
    destination: string,
    sourcePaths: readonly string[],
  ) => Promise<CreateOnlyWriter>
  /** Paths the destination must never alias; also handed to the writer. */
  readonly sourcePaths: readonly string[]
}

/** The five incoming export frames, one method each. */
export interface ExportTransferController {
  request(message: unknown): void
  start(message: unknown): void
  chunk(message: unknown): void
  finish(message: unknown): void
  cancel(message: unknown): void
  /**
   * Terminal: cancel the owned transfer, clean up its writer and ignore every
   * later frame. Idempotent.
   */
  dispose(): Promise<void>
}

interface ExportRequest {
  readonly id: string
  readonly generation: number
  readonly format: SafeExportFormat
}

/** Non-negative safe integer (the wire's generation/totalBytes bound). */
function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

/** Ingress: the export request envelope (id/generation/format), nothing else. */
function parseExportRequest(message: unknown): ExportRequest | undefined {
  if (typeof message !== 'object' || message === null) return undefined
  const value = message as {
    readonly id?: unknown
    readonly generation?: unknown
    readonly format?: unknown
  }
  if (typeof value.id !== 'string' || value.id.length === 0 || value.id.length > MAX_ID_LENGTH)
    return undefined
  if (!isCount(value.generation)) return undefined
  if (
    typeof value.format !== 'string' ||
    !SAFE_EXPORT_FORMATS.includes(value.format as SafeExportFormat)
  )
    return undefined
  return { id: value.id, generation: value.generation, format: value.format as SafeExportFormat }
}

/** Create the export transfer controller over explicit host dependencies. */
export function createExportTransferController(
  deps: ExportTransferControllerDeps,
): ExportTransferController {
  let writer: CreateOnlyWriter | undefined
  let state: ExportTransferState | undefined
  let id: string | undefined
  let generation = 0
  let writePending = false
  let acquiring = false
  /**
   * Ownership epoch: bumped by every cleanup, so an in-flight write/close/
   * acquisition continuation can tell it no longer owns the transfer. Strictly
   * increasing, never compared across transfers except by capture-and-compare.
   */
  let epoch = 0
  let disposed = false

  /** Cancel and release the owned transfer (idempotent, never throws). */
  const cleanup = async (): Promise<void> => {
    epoch += 1
    const owned = writer
    writer = undefined
    state = undefined
    id = undefined
    writePending = false
    await owned?.cleanup()
  }

  const postError = (
    requestId: string,
    requestGeneration: number,
    errorKind: 'destination-refused' | 'export-failed' | 'export-busy',
  ): void => {
    deps.post({
      kind: 'export-error',
      id: requestId,
      generation: requestGeneration,
      errorKind,
    })
  }

  /** Acquire a destination and open the owned create-only writer. */
  const acquire = async (request: ExportRequest, ownedEpoch: number): Promise<void> => {
    try {
      const destination = await deps.acquireDestination(request.format)
      if (disposed || epoch !== ownedEpoch) return
      if (destination.kind === 'cancelled') {
        deps.post({ kind: 'export-cancelled', id: request.id, generation: request.generation })
        return
      }
      if (destination.scheme !== 'file' || deps.sourcePaths.includes(destination.fsPath)) {
        postError(request.id, request.generation, 'destination-refused')
        return
      }
      let created: CreateOnlyWriter
      try {
        created = await deps.createWriter(destination.fsPath, [...deps.sourcePaths])
      } catch {
        if (!disposed && epoch === ownedEpoch)
          postError(request.id, request.generation, 'destination-refused')
        return
      }
      if (disposed || epoch !== ownedEpoch) {
        // The panel went away while the file was being created: the writer is
        // owned but nobody can consume it — remove it, report nothing.
        await created.cleanup()
        return
      }
      writer = created
      id = request.id
      generation = request.generation
      deps.post({ kind: 'export-ready', id: request.id, generation: request.generation })
    } catch {
      if (!disposed && epoch === ownedEpoch)
        postError(request.id, request.generation, 'export-failed')
    } finally {
      acquiring = false
    }
  }

  return {
    request(message: unknown): void {
      const request = parseExportRequest(message)
      if (request === undefined || disposed) return
      if (acquiring || writer !== undefined || id !== undefined) {
        postError(request.id, request.generation, 'export-busy')
        return
      }
      acquiring = true
      const ownedEpoch = epoch
      void acquire(request, ownedEpoch)
    },

    start(message: unknown): void {
      if (disposed) return
      const start = message as { id?: unknown; generation?: unknown; totalBytes?: unknown } | null
      if (
        start === null ||
        start.id !== id ||
        start.generation !== generation ||
        typeof id !== 'string' ||
        !isCount(start.totalBytes) ||
        start.totalBytes > EXPORT_MAX_BYTES ||
        // A restart of the owned transfer would rewind the sequence and offset
        // bounds and let already-delivered bytes be appended again.
        state !== undefined
      ) {
        void cleanup()
        return
      }
      state = {
        id,
        generation,
        totalBytes: start.totalBytes,
        nextSequence: 0,
        nextOffset: 0,
      }
      deps.post({ kind: 'export-credit', id, generation })
    },

    chunk(message: unknown): void {
      if (disposed) return
      const owned = writer
      const ownedId = id
      const ownedGeneration = generation
      const current = state
      if (owned === undefined || ownedId === undefined || current === undefined || writePending) {
        void cleanup()
        if (ownedId !== undefined) postError(ownedId, ownedGeneration, 'export-failed')
        return
      }
      let accepted: { readonly state: ExportTransferState; readonly bytes: Uint8Array }
      try {
        accepted = acceptExportFrame(current, message)
      } catch {
        void cleanup()
        postError(ownedId, ownedGeneration, 'export-failed')
        return
      }
      // Only an ACCEPTED frame advances the transfer and reaches the writer.
      state = accepted.state
      writePending = true
      const ownedEpoch = epoch
      void owned.write(accepted.bytes).then(
        () => {
          if (epoch !== ownedEpoch) return
          writePending = false
          deps.post({ kind: 'export-credit', id: ownedId, generation: ownedGeneration })
        },
        () => {
          if (epoch !== ownedEpoch) return
          writePending = false
          void cleanup()
          postError(ownedId, ownedGeneration, 'export-failed')
        },
      )
    },

    finish(message: unknown): void {
      if (disposed) return
      const done = message as { id?: unknown; generation?: unknown } | null
      const owned = writer
      const ownedId = id
      const ownedGeneration = generation
      const current = state
      if (
        done === null ||
        done.id !== ownedId ||
        done.generation !== ownedGeneration ||
        owned === undefined ||
        ownedId === undefined ||
        current === undefined ||
        current.nextOffset !== current.totalBytes
      ) {
        void cleanup()
        return
      }
      const ownedEpoch = epoch
      void owned.close().then(
        () => {
          // A cancel (or session change/disposal) may land while `close()` is
          // in flight: it owns the terminal response and already released the
          // writer. The disposal flag alone cannot tell that apart — the epoch
          // does, and cleanup must stay with the transfer that still owns it
          // (cleaning up here would release a newer transfer).
          if (disposed || epoch !== ownedEpoch) return
          void cleanup()
          deps.post({ kind: 'export-complete', id: ownedId, generation: ownedGeneration })
        },
        () => {
          if (disposed || epoch !== ownedEpoch) return
          void cleanup()
          postError(ownedId, ownedGeneration, 'export-failed')
        },
      )
    },

    cancel(message: unknown): void {
      if (disposed) return
      const cancel = message as { id?: unknown; generation?: unknown } | null
      if (
        cancel === null ||
        typeof cancel.id !== 'string' ||
        cancel.id !== id ||
        !isCount(cancel.generation) ||
        cancel.generation !== generation
      )
        return
      void cleanup()
      deps.post({ kind: 'export-cancelled', id: cancel.id, generation: cancel.generation })
    },

    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      await cleanup()
    },
  }
}
