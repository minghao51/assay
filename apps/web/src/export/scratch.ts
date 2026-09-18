/**
 * Read the engine's OPFS scratch exports (m4-5).
 *
 * The merged export op (m4-2) materializes the effective view into an
 * origin-private-filesystem scratch file under `assay-exports/…` (ADR 0017
 * disposable cache) and returns that **OPFS-relative** path. Dedicated workers
 * and the page share one origin OPFS, so the main thread reads the same bytes
 * through `navigator.storage.getDirectory()` — no new browser capability and
 * no second write. The source file is never involved (ADR 0012).
 *
 * Structural types keep this Node-testable with injected fake scopes; the real
 * `StorageManager`/`FileSystemDirectoryHandle` are already structurally
 * compatible (`apps/web` compiles against TypeScript's `lib.dom`). Totality:
 * a malformed/empty path and a missing entry throw real errors the caller
 * surfaces readably — this module never fabricates bytes.
 */

/** The slice of `FileSystemFileHandle` this module reads. */
export interface ScratchFileHandle {
  getFile(): Promise<Blob>
}

/** The slice of `FileSystemDirectoryHandle` this module walks. */
export interface ScratchDirectoryHandle {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<ScratchDirectoryHandle>
  getFileHandle(name: string): Promise<ScratchFileHandle>
}

/** The slice of `navigator.storage` this module needs. */
export interface ScratchScope {
  getDirectory(): Promise<ScratchDirectoryHandle>
}

/**
 * Read the bytes of an OPFS-relative path (e.g. `assay-exports/assay-export-1.csv`).
 * Slash-separated; every segment but the last is a directory that must exist
 * (the engine's write created it).
 */
export async function readOpfsBytes(
  path: string,
  scope: ScratchScope | undefined = defaultScope(),
): Promise<Uint8Array<ArrayBuffer>> {
  const segments = path.split('/').filter((segment) => segment.length > 0)
  const fileName = segments.pop()
  if (fileName === undefined) {
    throw new Error('the export path was empty')
  }
  let directory = await scope.getDirectory()
  for (const segment of segments) {
    directory = await directory.getDirectoryHandle(segment)
  }
  const handle = await directory.getFileHandle(fileName)
  const file = await handle.getFile()
  return new Uint8Array(await file.arrayBuffer())
}

/** The real OPFS entry point, resolved lazily so import has no DOM side effect. */
function defaultScope(): ScratchScope {
  const storage = globalThis.navigator?.storage
  if (storage === undefined || typeof storage.getDirectory !== 'function') {
    throw new Error('this browser does not expose the origin private file system')
  }
  return storage
}
