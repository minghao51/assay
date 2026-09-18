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
 * probe turned a 682-byte Parquet source into 144 bytes of CSV that way. The
 * caller therefore threads the identity the open flow retained
 * (`SourceIdentity`); when the picked handle is (or may be) that same entry,
 * `requestSaveDestination` resolves a `refused-source` outcome **before any
 * engine work or byte write**, which the dialog renders as an alert. Cancel
 * is a real outcome (the picker's `AbortError`), not a failure. No dataset
 * content is logged (ADR 0025).
 */
import type { EngineExportResult, EngineExportFormat } from '@assay/engine-duckdb'
import { exportFormatInfo } from './formats'
import { readOpfsBytes } from './scratch'

/** How the export bytes reached the user. */
export type SaveStrategy = 'file-system-access' | 'download'

/** The writable slice of a picked save handle (DOM `FileSystemFileHandle` satisfies it). */
export interface SaveFileHandle {
  createWritable(): Promise<SaveWritable>
  /**
   * Optional because only the `file-matching` identity probe reads it (the
   * DOM handle has it; minimal test fakes may omit it — then there is no
   * probe and no suspicion, see `sameEntryRefusal`).
   */
  getFile?(): Promise<File>
}

export interface SaveWritable {
  write(chunk: Uint8Array<ArrayBuffer>): Promise<void>
  close(): Promise<void>
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
 *
 * - `provable` — the source was opened through a File System Access handle;
 *   `isSameEntry` is the platform's authoritative same-entry verdict.
 * - `file-matching` — the source has no handle (hidden-input fallback path:
 *   a plain `File` has no `FileSystemHandle` representation in the web
 *   platform), so same-entry identity can only be *suspected*, from
 *   name + size + lastModified. A full match refuses conservatively. A
 *   mismatch can still, rarely, be the same entry (externally modified since
 *   open) — a documented residual risk this heuristic cannot close; no web
 *   API proves entry identity for a plain `File`.
 */
export type SourceIdentity =
  | {
      readonly kind: 'provable'
      /** The DOM handle's own `isSameEntry`, bound (authoritative verdict). */
      readonly isSameEntry: (other: FileSystemHandle) => Promise<boolean>
    }
  | {
      readonly kind: 'file-matching'
      readonly name: string
      readonly size: number
      readonly lastModified: number
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
   * Absent when nothing is known — the guard then cannot suspect anything
   * and stays out of the way (see `sameEntryRefusal`).
   */
  readonly sourceIdentity?: SourceIdentity
}

/** Bytes reader, injectable so Node tests never touch OPFS. */
export type ReadExportBytes = (path: string) => Promise<Uint8Array<ArrayBuffer>>

/** Download delivery, injectable so Node tests capture instead of downloading. */
export type DeliverDownload = (blob: Blob, fileName: string) => void

/**
 * Whether the picked save handle is (or may be) the opened source itself —
 * checked **before** the engine export runs and before any byte is written.
 * Any doubt refuses: the cost of a false refusal is the user picking another
 * name/location; the cost of a false allow is the opened file silently
 * replaced by its own export (the ADR 0012 data-loss path this guard exists
 * for), so uncertainty always breaks toward refusal on the authoritative
 * path and toward allowing on the heuristic one (a flaky probe must not
 * block legitimate saves — the probe is only ever a suspicion).
 */
async function sameEntryRefusal(
  identity: SourceIdentity | undefined,
  handle: SaveFileHandle,
): Promise<boolean> {
  if (identity === undefined) return false
  if (identity.kind === 'file-matching') {
    const probe = handle.getFile
    if (typeof probe !== 'function') return false // nothing to suspect from
    try {
      const file = await probe.call(handle)
      return (
        file.name === identity.name &&
        file.size === identity.size &&
        file.lastModified === identity.lastModified
      )
    } catch {
      return false // probe failed: no suspicion, never a fabricated one
    }
  }
  // `provable`: the platform's own verdict. If it is unavailable or rejects,
  // identity cannot be proven different — refuse (fail closed). The cast is
  // sound at runtime: a real picker resolves a DOM FileSystemFileHandle (the
  // structural `SaveFileHandle` simply does not re-declare the DOM
  // supertype), and a fake identity's `isSameEntry` ignores the argument.
  try {
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
 * Read the engine's OPFS scratch bytes for `result.path` and deliver them to
 * the resolved destination. Resolves the strategy actually used, so the result
 * line can say honestly where the copy went.
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
    await writable.write(bytes)
    await writable.close()
    return 'file-system-access'
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
