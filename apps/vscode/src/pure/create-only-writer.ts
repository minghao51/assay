// SPDX-License-Identifier: AGPL-3.0-or-later
import { open, lstat, unlink, realpath } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'

/**
 * The create-only export writer (ptv2-3; acquisition safety pinned by B04).
 *
 * The ACQUISITION contract is unchanged: the destination is canonicalized
 * against its real parent directory, a path that IS one of the caller's
 * sources is refused, and the file is created with `wx` + mode `0o600`, so an
 * existing or concurrently created path is never reopened, truncated or
 * overwritten. The refusal vocabulary is also unchanged:
 * `destination-refused` (existing path, source alias, unusable destination),
 * `destination-raced` (the path stopped being the file this writer opened),
 * `write-failed` (nonpositive write progress, or a write after release).
 *
 * LIFECYCLE phases — why the writer is modelled this way:
 *
 *     not-open → opened-unverified → owned → writing → closed
 *
 * `open` succeeding and `stat` identifying the handle are two different
 * moments. In between, the writer holds a path it cannot yet describe: it
 * knows it created *something*, not which inode it is. Every failure in that
 * window therefore CLOSES the handle and leaves the path alone — without a
 * reliable dev/ino/nlink identity no unlink can be justified, so an empty
 * unverified file may remain. Only once `stat` reports `isFile()` and
 * `nlink === 1` is the identity fixed; from then on every failure path goes
 * through one narrow cleanup routine (close once, then unlink only on an
 * exact re-matched identity).
 *
 * BEST-EFFORT RESIDUE — not atomicity. Cleanup re-reads the path with
 * `lstat` and unlinks only when dev, ino and nlink still match the identity
 * the writer established. The check and the unlink are two separate syscalls,
 * so a replacement that appears between them can still be removed: there is
 * no portable compare-and-unlink. This module makes NO atomic-delivery claim
 * and NO universal "a replacement is safe" promise; the honest guarantee is
 * that a writer never unlinks a path it has not identified as its own, and
 * that a path whose identity is unknown is never unlinked at all. A failed
 * close still runs the cleanup decision (a writer that cannot prove delivery
 * must not leave an unreported partial file behind); a cleanup that cannot
 * prove ownership leaves the residue and the caller reports the failure.
 *
 * CONCURRENCY: `close()` and `cleanup()` each memoize ONE in-flight promise,
 * so N callers observe one outcome and the handle is never closed twice. A
 * `cleanup()` that lands during a `close()` adopts that close: after a
 * verified close it is a no-op (a delivered file is never deleted), after a
 * failed one it still runs the cleanup decision without retrying the close.
 * A `close()` after a completed `cleanup()` reports `destination-raced` — the
 * path was already released, so no delivery can be claimed for it.
 */

export interface CreateOnlyWriter {
  write(bytes: Uint8Array): Promise<void>
  close(): Promise<void>
  cleanup(): Promise<void>
}

/**
 * The identity facts the writer relies on. `fs.Stats` satisfies this
 * structurally; the test seam supplies its own objects.
 *
 * @internal Test seam (B04) — stripped from any emitted declarations by
 * `stripInternal`.
 */
export interface CreateOnlyWriterStat {
  readonly dev: number
  readonly ino: number
  readonly nlink: number
  isFile(): boolean
}

/**
 * The narrow filesystem surface the writer uses. Injectable ONLY so the
 * acquisition/cleanup phases can be fault-injected (B04 acceptance); the
 * extension runtime goes through `createOnlyWriter` and the real `node:fs`.
 *
 * @internal Test seam (B04) — stripped from any emitted declarations by
 * `stripInternal`; the extension build bundles this module without exporting
 * it (`dist/extension.cjs` exports only `activate`/`deactivate`).
 */
export interface CreateOnlyWriterFs {
  readonly open: (path: string, flags: string, mode: number) => Promise<FileHandle>
  readonly stat: (handle: FileHandle) => Promise<CreateOnlyWriterStat>
  readonly sync: (handle: FileHandle) => Promise<void>
  readonly write: (
    handle: FileHandle,
    bytes: Uint8Array,
    offset: number,
    length: number,
  ) => Promise<{ readonly bytesWritten: number }>
  readonly close: (handle: FileHandle) => Promise<void>
  readonly lstat: (path: string) => Promise<CreateOnlyWriterStat>
  readonly unlink: (path: string) => Promise<void>
}

/** The real `node:fs` implementation of the writer's surface. */
const nodeFs: CreateOnlyWriterFs = {
  open: (path, flags, mode) => open(path, flags, mode),
  stat: (handle) => handle.stat(),
  sync: (handle) => handle.sync(),
  write: (handle, bytes, offset, length) => handle.write(bytes, offset, length, null),
  close: (handle) => handle.close(),
  lstat: (path) => lstat(path),
  unlink: (path) => unlink(path),
}

/** Create a new regular file; cleanup is best-effort (see the module doc). */
export async function createOnlyWriter(
  destination: string,
  sourcePaths: readonly string[] = [],
): Promise<CreateOnlyWriter> {
  return createOnlyWriterWithFs(nodeFs, destination, sourcePaths)
}

/**
 * Internal test seam (B04): the same writer over an injected fs surface. Not a
 * runtime entry point — `createOnlyWriter` above is the only production
 * caller, and no `fs` option is threaded through the extension API.
 *
 * @internal Stripped from any emitted declarations by `stripInternal`; the
 * extension runtime surface is `createOnlyWriter` alone.
 */
export async function createOnlyWriterWithFs(
  fs: CreateOnlyWriterFs,
  destination: string,
  sourcePaths: readonly string[] = [],
): Promise<CreateOnlyWriter> {
  const requested = resolve(destination)
  const parent = await realpath(dirname(requested))
  const target = resolve(parent, basename(requested))
  for (const source of sourcePaths) {
    let canonicalSource = resolve(source)
    try {
      canonicalSource = await realpath(canonicalSource)
    } catch {
      /* caller source may already be gone */
    }
    if (canonicalSource === target) throw new Error('destination-refused')
  }
  const owned = await acquireOwned(fs, target)
  const identity = { dev: owned.dev, ino: owned.ino }
  let closeStarted = false
  let delivered = false
  let cleanupStarted = false
  let closePromise: Promise<void> | undefined
  let cleanupPromise: Promise<void> | undefined

  /** Close the handle at most once: a failed close is never retried blindly. */
  const closeHandleOnce = async (): Promise<void> => {
    if (closeStarted) return
    closeStarted = true
    await fs.close(owned.handle)
  }

  /**
   * The one cleanup routine: close first (a failed close never skips the
   * unlink decision), then unlink ONLY the identity this writer established.
   * Everything is swallowed — cleanup is best-effort and returns no verdict.
   */
  const runCleanup = async (): Promise<void> => {
    await closeHandleOnce().catch(() => undefined)
    if (delivered) return
    try {
      const current = await fs.lstat(target)
      if (
        !current.isFile() ||
        current.dev !== identity.dev ||
        current.ino !== identity.ino ||
        current.nlink !== 1
      )
        return
      await fs.unlink(target)
    } catch {
      /* absent, replaced, unreadable: never remove a path this writer cannot prove it owns */
    }
  }

  const matches = (current: CreateOnlyWriterStat): boolean =>
    current.isFile() &&
    current.dev === identity.dev &&
    current.ino === identity.ino &&
    current.nlink === 1

  const runClose = async (): Promise<void> => {
    try {
      await fs.sync(owned.handle)
      if (!matches(await fs.lstat(target))) throw new Error('destination-raced')
      await closeHandleOnce()
      if (!matches(await fs.lstat(target))) throw new Error('destination-raced')
      delivered = true
    } catch (error) {
      // The primary authored failure is preserved; the cleanup decision still
      // runs (it re-verifies ownership, so a replacement is never removed).
      await runCleanup()
      throw error
    }
  }

  return {
    async write(bytes: Uint8Array): Promise<void> {
      if (closeStarted || cleanupStarted) throw new Error('write-failed')
      let offset = 0
      while (offset < bytes.byteLength) {
        const result = await fs.write(owned.handle, bytes, offset, bytes.byteLength - offset)
        if (result.bytesWritten <= 0) throw new Error('write-failed')
        offset += result.bytesWritten
      }
    },
    close(): Promise<void> {
      if (closePromise !== undefined) return closePromise
      closePromise = cleanupStarted
        ? (async (): Promise<void> => {
            throw new Error('destination-raced')
          })()
        : runClose()
      return closePromise
    },
    cleanup(): Promise<void> {
      if (cleanupPromise !== undefined) return cleanupPromise
      cleanupStarted = true
      cleanupPromise = (async (): Promise<void> => {
        // A cleanup that lands mid-close adopts that close's outcome instead
        // of racing it (one handle close, one verdict).
        await closePromise?.catch(() => undefined)
        await runCleanup()
      })()
      return cleanupPromise
    },
  }
}

interface OwnedHandle {
  readonly handle: FileHandle
  readonly dev: number
  readonly ino: number
}

/**
 * The `not-open → opened-unverified → owned` half of the lifecycle. A failure
 * anywhere after `open` closes the handle; without a reliable identity the
 * path is left alone (an unverified empty file may remain — documented
 * residue, never a guess-unlink).
 */
async function acquireOwned(fs: CreateOnlyWriterFs, target: string): Promise<OwnedHandle> {
  let handle: FileHandle
  try {
    handle = await fs.open(target, 'wx', 0o600)
  } catch {
    throw new Error('destination-refused')
  }
  try {
    const opened = await fs.stat(handle)
    if (!opened.isFile() || opened.nlink !== 1) throw new Error('destination-refused')
    return { handle, dev: opened.dev, ino: opened.ino }
  } catch (error) {
    await fs.close(handle).catch(() => undefined)
    throw error
  }
}
