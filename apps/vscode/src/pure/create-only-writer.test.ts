// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createOnlyWriter, createOnlyWriterWithFs } from './create-only-writer'
import type { CreateOnlyWriterFs, CreateOnlyWriterStat } from './create-only-writer'

let directory = ''
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})
async function tempDir(): Promise<string> {
  directory = await mkdtemp(join(tmpdir(), 'assay-export-'))
  return directory
}

describe('create-only export writer', () => {
  it('refuses an existing file without changing it', async () => {
    const dir = await tempDir()
    const target = join(dir, 'target.csv')
    await writeFile(target, 'original')
    await expect(createOnlyWriter(target)).rejects.toThrow('destination-refused')
    expect(await readFile(target, 'utf8')).toBe('original')
  })
  it('removes only its owned partial file on cancellation', async () => {
    const dir = await tempDir()
    const target = join(dir, 'partial.csv')
    const writer = await createOnlyWriter(target)
    await writer.write(Uint8Array.from([1, 2, 3]))
    await writer.cleanup()
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('never removes a replacement inode during cleanup', async () => {
    const dir = await tempDir()
    const target = join(dir, 'raced.csv')
    const writer = await createOnlyWriter(target)
    await unlink(target)
    await writeFile(target, 'replacement')
    await writer.cleanup()
    expect(await readFile(target, 'utf8')).toBe('replacement')
  })
  it('refuses a source alias', async () => {
    const dir = await tempDir()
    const target = join(dir, 'source.csv')
    await writeFile(target, 'source')
    await expect(createOnlyWriter(target, [target])).rejects.toThrow('destination-refused')
    expect(await readFile(target, 'utf8')).toBe('source')
  })
  it('refuses a source alias spelled through a different path, source unchanged', async () => {
    const dir = await tempDir()
    const source = join(dir, 'source.csv')
    await writeFile(source, 'source')
    await mkdir(join(dir, 'nested'))
    // `nested/..` canonicalizes back to `dir`, so this IS the source path.
    const spelled = join(dir, 'nested', '..', 'source.csv')
    await expect(createOnlyWriter(spelled, [source])).rejects.toThrow('destination-refused')
    expect(await readFile(source, 'utf8')).toBe('source')
  })
  it('delivers the written bytes and keeps them through repeated cleanup', async () => {
    const dir = await tempDir()
    const target = join(dir, 'delivered.csv')
    const writer = await createOnlyWriter(target)
    await writer.write(Uint8Array.from([1, 2]))
    await writer.write(Uint8Array.from([3]))
    await writer.close()
    // Repeated and concurrent cleanup after a completed close is a no-op: a
    // delivered file is never deleted (the pre-B04 writer unlinked it here).
    await Promise.all([writer.cleanup(), writer.cleanup(), writer.cleanup()])
    await writer.cleanup()
    expect(await readFile(target)).toEqual(Buffer.from([1, 2, 3]))
  })
  it('reports one verdict for concurrent and repeated closes', async () => {
    const dir = await tempDir()
    const target = join(dir, 'close-twice.csv')
    const writer = await createOnlyWriter(target)
    await writer.write(Uint8Array.from([9]))
    await Promise.all([writer.close(), writer.close()])
    await writer.close()
    expect(await readFile(target)).toEqual(Buffer.from([9]))
  })
  it('reports destination-raced when the path is replaced before the close identity check', async () => {
    const dir = await tempDir()
    const target = join(dir, 'close-raced.csv')
    const writer = await createOnlyWriter(target)
    await writer.write(Uint8Array.from([7]))
    await unlink(target)
    await writeFile(target, 'replacement')
    await expect(writer.close()).rejects.toThrow('destination-raced')
    await writer.cleanup()
    expect(await readFile(target, 'utf8')).toBe('replacement')
  })
  it('rejects a write after release with the authored category', async () => {
    const dir = await tempDir()
    const target = join(dir, 'after-close.csv')
    const closedWriter = await createOnlyWriter(target)
    await closedWriter.close()
    await expect(closedWriter.write(Uint8Array.from([1]))).rejects.toThrow('write-failed')
    const cancelled = await createOnlyWriter(join(dir, 'after-cleanup.csv'))
    await cancelled.cleanup()
    await expect(cancelled.write(Uint8Array.from([1]))).rejects.toThrow('write-failed')
    await expect(cancelled.close()).rejects.toThrow('destination-raced')
  })
})

/** Per-operation call counters plus optional fault injection over the real fs. */
interface ProbeFs {
  readonly fs: CreateOnlyWriterFs
  readonly calls: {
    stat: number
    sync: number
    write: number
    close: number
    lstat: number
    unlink: number
  }
}

function probeFs(overrides: Partial<CreateOnlyWriterFs> = {}): ProbeFs {
  const calls = { stat: 0, sync: 0, write: 0, close: 0, lstat: 0, unlink: 0 }
  const fs: CreateOnlyWriterFs = {
    open: (path, flags, mode) => open(path, flags, mode),
    stat: async (handle) => {
      calls.stat += 1
      return overrides.stat === undefined ? await handle.stat() : await overrides.stat(handle)
    },
    sync: async (handle) => {
      calls.sync += 1
      if (overrides.sync !== undefined) await overrides.sync(handle)
      else await handle.sync()
    },
    write: async (handle, bytes, offset, length) => {
      calls.write += 1
      return overrides.write === undefined
        ? await handle.write(bytes, offset, length, null)
        : await overrides.write(handle, bytes, offset, length)
    },
    close: async (handle) => {
      calls.close += 1
      if (overrides.close !== undefined) await overrides.close(handle)
      else await handle.close()
    },
    lstat: async (path) => {
      calls.lstat += 1
      return overrides.lstat === undefined ? await lstat(path) : await overrides.lstat(path)
    },
    unlink: async (path) => {
      calls.unlink += 1
      if (overrides.unlink !== undefined) await overrides.unlink(path)
      else await unlink(path)
    },
  }
  return { fs, calls }
}

const statOf = (overrides: Partial<CreateOnlyWriterStat>): CreateOnlyWriterStat => ({
  dev: 1,
  ino: 2,
  nlink: 1,
  isFile: () => true,
  ...overrides,
})

describe('create-only export writer — acquisition and cleanup fault injection', () => {
  it('closes the handle when stat fails and never unlinks an unverified path', async () => {
    const dir = await tempDir()
    const target = join(dir, 'stat-failed.csv')
    const { fs, calls } = probeFs({
      stat: async () => {
        throw new Error('stat-failed')
      },
    })
    await expect(createOnlyWriterWithFs(fs, target)).rejects.toThrow('stat-failed')
    expect(calls.close).toBe(1)
    expect(calls.unlink).toBe(0)
    // Documented residue: an empty file this writer created but never
    // identified may remain — it is never guessed away.
    expect(await readFile(target, 'utf8')).toBe('')
  })

  it('closes the handle and refuses a destination that is not a single-link file', async () => {
    const dir = await tempDir()
    const target = join(dir, 'linked.csv')
    const { fs, calls } = probeFs({ stat: async () => statOf({ nlink: 2 }) })
    await expect(createOnlyWriterWithFs(fs, target)).rejects.toThrow('destination-refused')
    expect(calls.close).toBe(1)
    expect(calls.unlink).toBe(0)
    expect(await readFile(target, 'utf8')).toBe('')

    const notFile = probeFs({ stat: async () => statOf({ isFile: () => false }) })
    await expect(createOnlyWriterWithFs(notFile.fs, join(dir, 'not-file.csv'))).rejects.toThrow(
      'destination-refused',
    )
    expect(notFile.calls.close).toBe(1)
    expect(notFile.calls.unlink).toBe(0)
  })

  it('keeps the primary failure and still runs the cleanup decision when sync fails', async () => {
    const dir = await tempDir()
    const target = join(dir, 'sync-failed.csv')
    const { fs, calls } = probeFs({
      sync: async () => {
        throw new Error('sync-failed')
      },
    })
    const writer = await createOnlyWriterWithFs(fs, target)
    await writer.write(Uint8Array.from([1, 2, 3]))
    await expect(writer.close()).rejects.toThrow('sync-failed')
    expect(calls.sync).toBe(1)
    expect(calls.close).toBe(1)
    expect(calls.unlink).toBe(1)
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('still closes and decides cleanup when the first identity lstat fails', async () => {
    const dir = await tempDir()
    const target = join(dir, 'lstat-first-failed.csv')
    let seen = 0
    const { fs, calls } = probeFs({
      lstat: async (path) => {
        seen += 1
        if (seen === 1) throw new Error('lstat-failed')
        return await lstat(path)
      },
    })
    const writer = await createOnlyWriterWithFs(fs, target)
    await writer.write(Uint8Array.from([4]))
    await expect(writer.close()).rejects.toThrow('lstat-failed')
    expect(calls.close).toBe(1)
    expect(calls.unlink).toBe(1)
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('still removes only its own file when the final post-close lstat fails', async () => {
    const dir = await tempDir()
    const target = join(dir, 'lstat-final-failed.csv')
    let seen = 0
    const { fs, calls } = probeFs({
      lstat: async (path) => {
        seen += 1
        if (seen === 2) throw new Error('lstat-failed')
        return await lstat(path)
      },
    })
    const writer = await createOnlyWriterWithFs(fs, target)
    await writer.write(Uint8Array.from([5]))
    await expect(writer.close()).rejects.toThrow('lstat-failed')
    expect(calls.close).toBe(1)
    expect(calls.unlink).toBe(1)
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses delivery and removes nothing when the path is replaced at the final check', async () => {
    const dir = await tempDir()
    const target = join(dir, 'replaced-at-final.csv')
    const staging = join(dir, 'staging.csv')
    await writeFile(staging, 'replacement')
    let seen = 0
    const { fs, calls } = probeFs({
      lstat: async (path) => {
        seen += 1
        // The replacement becomes visible between the pre-close check and the
        // post-close check — the exact window B04 must not unlink through.
        if (seen === 2) await rename(staging, path)
        return await lstat(path)
      },
    })
    const writer = await createOnlyWriterWithFs(fs, target)
    await writer.write(Uint8Array.from([6]))
    await expect(writer.close()).rejects.toThrow('destination-raced')
    expect(calls.close).toBe(1)
    expect(calls.unlink).toBe(0)
    expect(await readFile(target, 'utf8')).toBe('replacement')
  })

  it('does not skip the cleanup decision when the handle close fails', async () => {
    const dir = await tempDir()
    const target = join(dir, 'close-failed.csv')
    const { fs, calls } = probeFs({
      close: async (handle) => {
        await handle.close()
        throw new Error('close-failed')
      },
    })
    const writer = await createOnlyWriterWithFs(fs, target)
    await writer.write(Uint8Array.from([7, 8]))
    await expect(writer.close()).rejects.toThrow('close-failed')
    expect(calls.close).toBe(1)
    expect(calls.unlink).toBe(1)
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports a failed close to every caller and closes the handle exactly once', async () => {
    const dir = await tempDir()
    const target = join(dir, 'close-failed-twice.csv')
    const { fs, calls } = probeFs({
      close: async (handle) => {
        await handle.close()
        throw new Error('close-failed')
      },
    })
    const writer = await createOnlyWriterWithFs(fs, target)
    await writer.write(Uint8Array.from([1]))
    const outcomes = await Promise.allSettled([writer.close(), writer.close()])
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected'])
    for (const outcome of outcomes) {
      expect(outcome.status === 'rejected' ? String(outcome.reason) : '').toContain('close-failed')
    }
    await expect(writer.close()).rejects.toThrow('close-failed')
    expect(calls.close).toBe(1)
    expect(calls.unlink).toBe(1)
    // The cleanup decision ran exactly once and left no debris behind.
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('swallows an unlink failure as best-effort residue', async () => {
    const dir = await tempDir()
    const target = join(dir, 'unlink-failed.csv')
    const { fs, calls } = probeFs({
      unlink: async () => {
        throw new Error('unlink-failed')
      },
    })
    const writer = await createOnlyWriterWithFs(fs, target)
    await writer.write(Uint8Array.from([1]))
    await expect(writer.cleanup()).resolves.toBeUndefined()
    expect(calls.unlink).toBe(1)
    expect(await readFile(target)).toEqual(Buffer.from([1]))
  })

  it('runs cleanup once for concurrent and repeated callers', async () => {
    const dir = await tempDir()
    const target = join(dir, 'cleanup-once.csv')
    const { fs, calls } = probeFs()
    const writer = await createOnlyWriterWithFs(fs, target)
    await writer.write(Uint8Array.from([1]))
    await Promise.all([writer.cleanup(), writer.cleanup(), writer.cleanup()])
    await writer.cleanup()
    expect(calls.close).toBe(1)
    expect(calls.unlink).toBe(1)
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('adopts an in-flight close instead of racing it and keeps the delivered file', async () => {
    const dir = await tempDir()
    const target = join(dir, 'cleanup-mid-close.csv')
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { fs, calls } = probeFs({
      sync: async () => {
        await gate
      },
    })
    const writer = await createOnlyWriterWithFs(fs, target)
    await writer.write(Uint8Array.from([1, 2]))
    const closing = writer.close()
    const cleaning = writer.cleanup()
    release()
    await closing
    await cleaning
    expect(calls.close).toBe(1)
    expect(calls.unlink).toBe(0)
    expect(await readFile(target)).toEqual(Buffer.from([1, 2]))
  })

  it('completes short writes by looping until the byte budget is spent', async () => {
    const dir = await tempDir()
    const target = join(dir, 'short-writes.csv')
    const { fs, calls } = probeFs({
      write: async (handle, bytes, offset, length) =>
        await handle.write(bytes, offset, Math.min(2, length), null),
    })
    const writer = await createOnlyWriterWithFs(fs, target)
    await writer.write(Uint8Array.from([1, 2, 3, 4, 5]))
    await writer.close()
    expect(calls.write).toBe(3)
    expect(await readFile(target)).toEqual(Buffer.from([1, 2, 3, 4, 5]))
  })

  it('rejects nonpositive write progress as write-failed', async () => {
    const dir = await tempDir()
    for (const bytesWritten of [0, -1]) {
      const target = join(dir, `zero-progress-${String(bytesWritten)}.csv`)
      const { fs } = probeFs({ write: async () => ({ bytesWritten }) })
      const writer = await createOnlyWriterWithFs(fs, target)
      await expect(writer.write(Uint8Array.from([1, 2]))).rejects.toThrow('write-failed')
      await writer.cleanup()
      await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it('propagates a write failure and lets the caller cancel', async () => {
    const dir = await tempDir()
    const target = join(dir, 'write-failed.csv')
    const { fs, calls } = probeFs({
      write: async () => {
        throw new Error('write-failed')
      },
    })
    const writer = await createOnlyWriterWithFs(fs, target)
    await expect(writer.write(Uint8Array.from([1]))).rejects.toThrow('write-failed')
    expect(calls.close).toBe(0)
    await writer.cleanup()
    expect(calls.close).toBe(1)
    expect(calls.unlink).toBe(1)
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
