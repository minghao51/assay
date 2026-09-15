/**
 * BrowserFileSource — a `DataSource` for one local file in the browser
 * (task M1-3). Local-first by construction (ADR 0001): the source only ever
 * holds a reference to a `File`/`FileSystemFileHandle` the user already
 * picked; no bytes are read here, nothing is uploaded, nothing is logged
 * (ADR 0025 — not even file names).
 *
 * Identity semantics (documented contract, asserted in tests and e2e):
 * - One `BrowserFileSource` instance has exactly one immutable `id`
 *   (`sourceId`), generated at construction (`crypto.randomUUID()`).
 * - `open()` is idempotent: every call resolves to the same frozen
 *   `DataHandle` object.
 * - Re-picking the same file creates a *new* source with a *new* id — the
 *   package deliberately does not claim persistent file identity, because
 *   stable cross-session ids would require persistent browser storage
 *   (ADR 0017 allows OPFS/IndexedDB for disposable caches only).
 * - The underlying `File` is resolved lazily exactly once (`getFile()` for
 *   the handle path; the given `File` for the fallback path) and cached, so
 *   `open()`/`metadata()` observe one consistent snapshot for the instance's
 *   lifetime.
 */
import { detectFormatFromFileName } from './detect-format'
import type { DataHandle, DataSource, DataSourceMetadata } from './index'

/** Exactly one of: a File System Access handle, or a plain `File` (input fallback). */
export type BrowserFileSourceInput =
  { readonly fileSystemHandle: FileSystemFileHandle } | { readonly file: File }

export class BrowserFileSource implements DataSource {
  readonly kind = 'browser-file'
  readonly id: string
  readonly #input: BrowserFileSourceInput
  #file: Promise<File> | null = null
  #handle: DataHandle | null = null

  constructor(input: BrowserFileSourceInput) {
    // Defensive runtime guard: non-TypeScript callers can bypass the union.
    const hasHandle = 'fileSystemHandle' in input
    const hasFile = 'file' in input
    if (hasHandle === hasFile) {
      throw new TypeError('BrowserFileSource requires exactly one of `fileSystemHandle` or `file`')
    }
    this.#input = input
    this.id = crypto.randomUUID()
  }

  /** Resolve a `DataHandle` for the engine. Idempotent per instance (see module docs). */
  async open(): Promise<DataHandle> {
    await this.#ensureFile()
    // The handle stays opaque ({ kind, sourceId } only); engines that need
    // byte access get it from the source/file they already hold (task M1-4).
    this.#handle ??= Object.freeze({ kind: 'data-handle', sourceId: this.id })
    return this.#handle
  }

  /**
   * Report format + size without reading dataset bytes: `File.size` is plain
   * file metadata, and the format comes from the file-name extension.
   * `rowCount`/`partitions` stay unset — engines fill those in later.
   */
  async metadata(): Promise<DataSourceMetadata> {
    const file = await this.#ensureFile()
    return { format: detectFormatFromFileName(file.name), sizeBytes: file.size }
  }

  /** Lazily fetch the `File` once and cache it (one consistent snapshot per instance). */
  #ensureFile(): Promise<File> {
    this.#file ??=
      'fileSystemHandle' in this.#input
        ? this.#input.fileSystemHandle.getFile()
        : Promise.resolve(this.#input.file)
    return this.#file
  }
}
