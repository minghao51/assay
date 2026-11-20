// SPDX-License-Identifier: AGPL-3.0-or-later

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
 * - The underlying `File` is acquired lazily through **one in-flight attempt**
 *   (`getFile()` for the handle path; the given `File` for the fallback
 *   path). Concurrent `open()`/`metadata()`/`getFile()` calls share that
 *   attempt and all observe its outcome.
 * - A *failed* attempt is deliberately retryable (decision Q3): the rejection
 *   is rethrown to every caller waiting on it, and the next call starts one
 *   fresh attempt. Retirement is identity-guarded — only the attempt the
 *   source currently holds may retire the cache, so a failure from an attempt
 *   that no longer owns it (a handle that re-enters `getFile()` while another
 *   acquisition is being created, leaving a superseded nested attempt) can
 *   never clear the cached attempt.
 * - A *fulfilled* attempt is retained for the instance's lifetime: its `File`
 *   is never re-fetched because the file changed on disk, so
 *   `open()`/`metadata()` keep observing one consistent snapshot.
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

  /**
   * The `File` for this source, acquired lazily through the one shared
   * attempt and then retained (the same consistent snapshot
   * `open()`/`metadata()` observe — see the identity semantics above). This
   * accessor (M1-4) lets engines that need the bytes reach them without a
   * package dependency in either direction: an engine takes a
   * `BrowserFileSource` through a structural seam. It never reads dataset
   * bytes here — resolving the reference only (ADR 0001/0025).
   */
  getFile(): Promise<File> {
    return this.#ensureFile()
  }

  /**
   * One acquisition attempt per instance, shared by every caller while it is
   * in flight. Fulfilment is kept forever; a rejection is rethrown and retires
   * the attempt so the next call retries once (never logging the source or
   * file name — ADR 0025).
   */
  #ensureFile(): Promise<File> {
    const cached = this.#file
    if (cached !== null) return cached

    // One attempt. A synchronous `getFile()` throw is captured into the same
    // path as an asynchronous rejection, so this accessor never throws
    // synchronously and every caller shares the attempt's outcome.
    let attempt: Promise<File>
    try {
      attempt =
        'fileSystemHandle' in this.#input
          ? this.#input.fileSystemHandle.getFile()
          : Promise.resolve(this.#input.file)
    } catch (error) {
      attempt = Promise.reject(error)
    }

    // `.catch` passes a fulfilled attempt through untouched; a rejection is
    // retired (see below) and rethrown to every caller.
    const shared: Promise<File> = attempt.catch((error: unknown) => {
      // Retry semantics (Q3): retire the failed attempt only while it is still
      // the cached one, so an older rejection can never clear a newer
      // in-flight attempt. The error propagates unchanged.
      if (this.#file === shared) this.#file = null
      throw error
    })
    this.#file = shared
    return shared
  }
}
