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
 * touched (ADR 0012). Cancel is a real outcome (the picker's `AbortError`),
 * not a failure. No dataset content is logged (ADR 0025).
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
}

/** A resolved destination: a real handle, or the download fallback. */
export type SaveDestination =
  | { readonly via: 'file-system-access'; readonly handle: SaveFileHandle }
  | { readonly via: 'download' }

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
}

/** Bytes reader, injectable so Node tests never touch OPFS. */
export type ReadExportBytes = (path: string) => Promise<Uint8Array<ArrayBuffer>>

/** Download delivery, injectable so Node tests capture instead of downloading. */
export type DeliverDownload = (blob: Blob, fileName: string) => void

/**
 * Acquire a destination for `format` before running the engine export.
 * Resolves `null` when the user dismisses the save picker; any other picker
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
  destination: SaveDestination,
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
