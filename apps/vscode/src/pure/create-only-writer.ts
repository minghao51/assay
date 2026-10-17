// SPDX-License-Identifier: AGPL-3.0-or-later
import { open, lstat, unlink, realpath } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'

export interface CreateOnlyWriter {
  write(bytes: Uint8Array): Promise<void>
  close(): Promise<void>
  cleanup(): Promise<void>
}

/** Create a new regular file atomically; cleanup unlinks only the opened inode. */
export async function createOnlyWriter(
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
  let handle: FileHandle
  try {
    handle = await open(target, 'wx', 0o600)
  } catch {
    throw new Error('destination-refused')
  }
  const owned = await handle.stat()
  if (!owned.isFile() || owned.nlink !== 1) {
    await handle.close()
    throw new Error('destination-refused')
  }
  let closed = false
  const cleanup = async (): Promise<void> => {
    if (!closed) {
      await handle.close().catch(() => undefined)
      closed = true
    }
    try {
      const current = await lstat(target)
      if (current.dev === owned.dev && current.ino === owned.ino && current.nlink === 1)
        await unlink(target)
    } catch {
      /* absent or replaced: never remove a replacement */
    }
  }
  return {
    async write(bytes) {
      let offset = 0
      while (offset < bytes.byteLength) {
        const result = await handle.write(bytes, offset, bytes.byteLength - offset, null)
        if (result.bytesWritten <= 0) throw new Error('write-failed')
        offset += result.bytesWritten
      }
    },
    async close() {
      if (!closed) {
        await handle.sync()
        const current = await lstat(target)
        if (
          !current.isFile() ||
          current.dev !== owned.dev ||
          current.ino !== owned.ino ||
          current.nlink !== 1
        ) {
          throw new Error('destination-raced')
        }
        await handle.close()
        closed = true
        const completed = await lstat(target)
        if (
          !completed.isFile() ||
          completed.dev !== owned.dev ||
          completed.ino !== owned.ino ||
          completed.nlink !== 1
        ) {
          throw new Error('destination-raced')
        }
      }
    },
    cleanup,
  }
}
