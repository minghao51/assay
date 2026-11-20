// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Destination + delivery for an export copy (m4-5).
 *
 * The engine writes the effective view (base + overlay) into OPFS scratch
 * (ADR 0017) and returns that path; this module turns those bytes into a file
 * the user actually has, using the established picker patterns (mirroring
 * `@assay/data-sources/src/capabilities.ts` + `pick-file.ts`, but implemented
 * here because `packages/**` is out of scope for m4-5):
 *
 * - `showSaveFilePicker` available → acquire a real file handle first (so the
 *   picker runs inside the click's user activation, even if the engine export
 *   then takes seconds), then write the OPFS bytes into it.
 * - otherwise → a hidden anchor download of those same bytes.
 *
 * Either way the write target is a **new file**; the opened source is never
 * touched (ADR 0012). That promise is enforced, not just worded (m4-5 fix
 * round): the save picker can return the *opened source's own entry*, and a
 * direct handle write would then silently replace the source — a real FSA
 * probe turned a 682-byte Parquet source into 144 bytes of CSV that way.
 *
 * Enforcement is keyed on what the open flow can prove (m4-5 fix round 2,
 * hardening round 1's heuristic):
 *
 * - The source was opened through a File System Access handle → the flow
 *   retained it (`SourceIdentity`), and the platform's authoritative
 *   `isSameEntry` verdict refuses a picked handle that IS that entry
 *   **before any engine work or byte write** (rendered as an alert).
 * - The source was opened without a handle (hidden-input fallback: a plain
 *   `File` has no `FileSystemHandle` representation in the web platform) →
 *   same-entry identity cannot be proven at all. Round 1 suspected matches
 *   from name + size + lastModified, but that probe misses the same entry
 *   after an external touch (mtime moved on), and no web API closes the
 *   gap — so such a session is **never offered the direct-write picker**:
 *   `requestSaveDestination` routes delivery through the anchor-download
 *   fallback, whose destination the browser manages and this code cannot
 *   point at the source. Fail-closed by construction, not by heuristic.
 *
 * Cancel is a real outcome (the picker's `AbortError`), not a failure. No
 * dataset content is logged (ADR 0025).
 */
import type { EngineExportResult, EngineExportFormat } from '@assay/engine-duckdb'
import { exportFormatInfo } from './formats'
import { readOpfsBytes } from './scratch'

/** How the export bytes reached the user. */
export type SaveStrategy = 'file-system-access' | 'download'

/** The writable slice of a picked save handle (DOM `FileSystemFileHandle` satisfies it). */
export interface SaveFileHandle {
  createWritable(): Promise<SaveWritable>
}

export interface SaveWritable {
  write(chunk: Uint8Array<ArrayBuffer>): Promise<void>
  close(): Promise<void>
  /**
   * Discard this writable's pending content (the DOM
   * `FileSystemWritableFileStream.abort()` operation). Optional: the platform
   * operation this module needs is write+close, so a structural fake without
   * it stays valid.
   *
   * B03 — failure cleanup: the helper attempts this AT MOST ONCE after the
   * write or the close fails, and ignores its own failure (the primary
   * rejection is the outcome the caller reports). It is never a success path
   * and never retried, and it makes no promise that a browser can restore a
   * destination — it only stops a partially written stream from being left
   * open on the platforms that support it.
   */
  abort?(reason?: unknown): Promise<void>
}

/** A resolved destination: a real handle, the download fallback, or a refusal. */
export type SaveDestination =
  | { readonly via: 'file-system-access'; readonly handle: SaveFileHandle }
  | { readonly via: 'download' }
  /**
   * The picked save handle is (or may be) the opened source's own entry.
   * Never a writable destination: the dialog renders `EXPORT_SAME_SOURCE_MESSAGE`
   * and the engine export is not even attempted.
   */
  | { readonly via: 'refused-source' }

/**
 * A destination the export bytes may actually be written to — i.e. any
 * `SaveDestination` except the same-source refusal. `writeExportCopy` takes
 * this narrowed type so a refusal can never reach a write.
 */
export type WritableSaveDestination = Exclude<SaveDestination, { readonly via: 'refused-source' }>

/**
 * What the open flow can attest about the opened source, threaded into the
 * save-picker request so a destination that *is* the opened file can be
 * refused before any engine work or byte write (ADR 0012 data-loss guard).
 * Present only when the source was opened through a File System Access
 * handle: `isSameEntry` is the platform's authoritative same-entry verdict.
 * When it is absent, identity cannot be proven and the save picker is not
 * offered at all (see `requestSaveDestination`) — there is no heuristic
 * fallback, because none can be made sound.
 */
export interface SourceIdentity {
  /** The DOM handle's own `isSameEntry`, bound (authoritative verdict). */
  readonly isSameEntry: (other: FileSystemHandle) => Promise<boolean>
}

/** What the browser can do for saving. */
export interface SaveCapabilities {
  /** `window.showSaveFilePicker()` exists. */
  readonly fileSavePicker: boolean
}

/** Structural view of the global the detector needs (injectable for tests). */
export interface SaveCapabilityScope {
  readonly showSaveFilePicker?: unknown
}

/** Detect save capability against `scope` (default `globalThis`). Existence only. */
export function detectSaveCapabilities(scope: SaveCapabilityScope = globalThis): SaveCapabilities {
  return { fileSavePicker: typeof scope.showSaveFilePicker === 'function' }
}

/** True for the DOMException a dismissed save picker raises. */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/** Picker entry point, injectable so tests never open a native dialog. */
export type ShowSaveFilePickerLike = (options: SaveFilePickerOptions) => Promise<SaveFileHandle>

export interface RequestDestinationDeps {
  readonly capabilities?: SaveCapabilities
  readonly showSaveFilePicker?: ShowSaveFilePickerLike
  /**
   * Opened-source identity for the same-source refusal (m4-5 fix round).
   * Present only for FSA-opened sources (the open flow retained the
   * handle). Absent for input-fallback sessions — identity cannot be
   * proven — and that absence means the picker is never offered (see
   * `requestSaveDestination`), not that the guard steps aside.
   */
  readonly sourceIdentity?: SourceIdentity
}

/** Bytes reader, injectable so Node tests never touch OPFS. */
export type ReadExportBytes = (path: string) => Promise<Uint8Array<ArrayBuffer>>

/** Download delivery, injectable so Node tests capture instead of downloading. */
export type DeliverDownload = (blob: Blob, fileName: string) => void

/**
 * Whether the picked save handle IS the opened source's entry — checked
 * **before** the engine export runs and before any byte is written. The
 * verdict is the platform's own (`isSameEntry`); if it is unavailable or
 * rejects, identity cannot be proven different — refuse (fail closed). The
 * cost of a false refusal is the user picking another name/location; the
 * cost of a false allow is the opened file silently replaced by its own
 * export (the ADR 0012 data-loss path this guard exists for).
 * SAFETY: the double assertion below is sound by construction, which TypeScript
 * cannot check: a real picker resolves a DOM `FileSystemFileHandle` (the
 * structural `SaveFileHandle` simply does not re-declare the DOM supertype), and
 * a fake identity's `isSameEntry` ignores the argument entirely. The value is
 * never read as anything but an opaque handle.
 */
async function sameEntryRefusal(
  identity: SourceIdentity,
  handle: SaveFileHandle,
): Promise<boolean> {
  try {
    // SAFETY: a real picker resolves a DOM FileSystemFileHandle, so the
    // structural SaveFileHandle is at runtime exactly the value isSameEntry
    // expects; a fake identity's isSameEntry ignores the argument. TypeScript
    // cannot check this because the structural interface deliberately does not
    // re-declare the DOM supertype.
    return await identity.isSameEntry(handle as unknown as FileSystemHandle)
  } catch {
    return true
  }
}

/**
 * Acquire a destination for `format` before running the engine export.
 * Resolves `null` when the user dismisses the save picker and
 * `{ via: 'refused-source' }` when the picker returned the opened source's
 * entry (refused before any engine work or byte write); any other picker
 * failure propagates (surfaced readably by the caller).
 */
export async function requestSaveDestination(
  format: EngineExportFormat,
  deps: RequestDestinationDeps = {},
): Promise<SaveDestination | null> {
  // Input-fallback session (no retained FSA handle): same-entry identity can
  // never be proven for a picked destination, so the direct-write picker is
  // not offered at all (m4-5 fix round 2 — round 1's name+size+lastModified
  // probe missed a source externally touched after opening, the exact
  // data-loss shape this guard exists for). Delivery rides the anchor
  // download instead: the browser picks the destination, our code never
  // acquires a writable, and the opened source is unreachable (ADR 0012).
  if (deps.sourceIdentity === undefined) return { via: 'download' }
  const capabilities = deps.capabilities ?? detectSaveCapabilities()
  if (!capabilities.fileSavePicker) return { via: 'download' }
  const pick: ShowSaveFilePickerLike =
    deps.showSaveFilePicker ?? ((options) => showSaveFilePicker(options))
  const info = exportFormatInfo(format)
  try {
    const handle = await pick({ suggestedName: `assay-export.${info.extension}` })
    if (await sameEntryRefusal(deps.sourceIdentity, handle)) {
      return { via: 'refused-source' }
    }
    return { via: 'file-system-access', handle }
  } catch (error) {
    if (isAbortError(error)) return null
    throw error
  }
}

export interface WriteCopyDeps {
  readonly readBytes?: ReadExportBytes
  readonly deliverDownload?: DeliverDownload
}

/**
 * The reason handed to `abort`. Deliberately value-free: the primary failure
 * can carry a scratch path or engine text (ADR 0025), and this module never
 * forwards either. It is an internal marker, not user-facing copy.
 */
const EXPORT_WRITE_ABORT_REASON = 'export write failed'

/**
 * One best-effort abort of a writable whose write or close failed. A writable
 * that does not expose `abort` is simply left to the browser's own teardown,
 * and an abort that itself rejects is swallowed: replacing the primary
 * rejection with the cleanup's error would misreport why the export failed.
 */
async function abortWritableOnce(writable: SaveWritable): Promise<void> {
  if (typeof writable.abort !== 'function') return
  try {
    await writable.abort(EXPORT_WRITE_ABORT_REASON)
  } catch {
    // Best effort by contract (B03): the primary failure is reported unchanged.
  }
}

/**
 * Read the engine's OPFS scratch bytes for `result.path` and deliver them to
 * the resolved destination. Resolves the strategy actually used, so the result
 * line can say honestly where the copy went.
 *
 * Order is load-bearing (m4-5, B03): the bytes are read BEFORE a writable
 * exists (a read failure never creates or touches one), and once
 * `createWritable` succeeds, `write` and `close` sit inside ONE failure
 * boundary — a failed write never falls through to `close` as if it had
 * succeeded, and either failure gets exactly one best-effort abort before the
 * original error propagates. A successful close is the only path that
 * resolves `'file-system-access'`; nothing is retried (a retry would deliver
 * the same export twice).
 */
export async function writeExportCopy(
  destination: WritableSaveDestination,
  result: EngineExportResult,
  deps: WriteCopyDeps = {},
): Promise<SaveStrategy> {
  const readBytes = deps.readBytes ?? ((path: string) => readOpfsBytes(path))
  const bytes = await readBytes(result.path)
  if (destination.via === 'file-system-access') {
    const writable = await destination.handle.createWritable()
    try {
      await writable.write(bytes)
      await writable.close()
      return 'file-system-access'
    } catch (error) {
      await abortWritableOnce(writable)
      throw error
    }
  }
  const info = exportFormatInfo(result.format)
  const blob = new Blob([bytes], { type: info.mimeType })
  const deliver = deps.deliverDownload ?? downloadBlob
  deliver(blob, `assay-export.${info.extension}`)
  return 'download'
}

/**
 * Hidden-anchor download of `blob`. The object URL is revoked on a generous
 * timer *after* the click, so the browser has certainly finished reading the
 * blob (revoking synchronously is racy in some engines).
 */
function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.rel = 'noopener'
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  globalThis.setTimeout(() => {
    URL.revokeObjectURL(url)
  }, 30_000)
}
