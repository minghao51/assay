// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test, vi } from 'vitest'
import { BrowserFileSource } from './browser-file-source'

const csvBytes = new TextEncoder().encode('a,b\n1,2\n')

/** Minimal but complete in-memory FileSystemFileHandle for the handle path. */
function fakeFileSystemFileHandle(file: File, onGetFile?: () => void): FileSystemFileHandle {
  return {
    kind: 'file',
    name: file.name,
    getFile: async () => {
      onGetFile?.()
      return file
    },
    isSameEntry: async () => false, // unused by the package; required by the interface
    createWritable: async () => {
      throw new Error('createWritable is not part of the read-only source contract')
    },
  }
}

describe('BrowserFileSource — File (input fallback) path', () => {
  test('open() resolves a well-formed, frozen DataHandle with a stable sourceId', async () => {
    const source = new BrowserFileSource({ file: new File([csvBytes], 'table.csv') })

    expect(source.kind).toBe('browser-file')
    expect(source.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)

    const handle = await source.open()
    expect(handle.kind).toBe('data-handle')
    expect(handle.sourceId).toBe(source.id)
    expect(Object.isFrozen(handle)).toBe(true)

    // Idempotency contract: re-open returns the identical handle object.
    const reopened = await source.open()
    expect(reopened).toBe(handle)
  })

  test('metadata() reports format and exact size without reading dataset bytes', async () => {
    const source = new BrowserFileSource({ file: new File([csvBytes], 'table.csv') })
    await expect(source.metadata()).resolves.toEqual({
      format: 'csv',
      sizeBytes: csvBytes.byteLength,
    })
  })

  test('metadata() leaves engine-owned fields (rowCount, partitions) unset', async () => {
    const source = new BrowserFileSource({ file: new File([csvBytes], 'data.jsonl') })
    const metadata = await source.metadata()
    expect(metadata).not.toHaveProperty('rowCount')
    expect(metadata).not.toHaveProperty('partitions')
  })

  test('detects every supported format from the File name', async () => {
    const names = [
      ['a.parquet', 'parquet'],
      ['b.jsonl', 'jsonl'],
      ['c.json', 'json'],
      ['d.csv', 'csv'],
      ['e.arrow', 'arrow'],
      ['f.feather', 'feather'],
      ['UPPER.CSV', 'csv'],
    ] as const
    for (const [name, format] of names) {
      const source = new BrowserFileSource({ file: new File([csvBytes], name) })
      await expect(source.metadata(), name).resolves.toEqual({
        format,
        sizeBytes: csvBytes.byteLength,
      })
    }
  })

  test('stays permissive for unknown formats: open() still works, format is "unknown"', async () => {
    const source = new BrowserFileSource({ file: new File([csvBytes], 'blob.bin') })
    await expect(source.open()).resolves.toEqual({
      kind: 'data-handle',
      sourceId: source.id,
    })
    await expect(source.metadata()).resolves.toEqual({
      format: 'unknown',
      sizeBytes: csvBytes.byteLength,
    })
  })

  test('each instance has its own identity — re-picking the same file yields a new sourceId', () => {
    const file = new File([csvBytes], 'table.csv')
    const first = new BrowserFileSource({ file })
    const second = new BrowserFileSource({ file })
    expect(first.id).not.toBe(second.id)
  })

  test('rejects construction without exactly one input', () => {
    expect(() => new BrowserFileSource({} as never)).toThrow(TypeError)
  })
})

describe('BrowserFileSource — FileSystemFileHandle (File System Access) path', () => {
  test('resolves the file through handle.getFile() and reports metadata', async () => {
    const file = new File([csvBytes], 'handle.jsonl')
    const source = new BrowserFileSource({
      fileSystemHandle: fakeFileSystemFileHandle(file),
    })
    await expect(source.metadata()).resolves.toEqual({
      format: 'jsonl',
      sizeBytes: csvBytes.byteLength,
    })
    const handle = await source.open()
    expect(handle.sourceId).toBe(source.id)
  })

  test('fetches the File exactly once and reuses the snapshot for open()/metadata()', async () => {
    let getFileCalls = 0
    const file = new File([csvBytes], 'snapshot.csv')
    const source = new BrowserFileSource({
      fileSystemHandle: fakeFileSystemFileHandle(file, () => {
        getFileCalls += 1
      }),
    })

    await source.open()
    await source.metadata()
    await source.open()
    expect(getFileCalls).toBe(1)
  })

  test('getFile() exposes the identical cached File snapshot (M1-4 engine seam)', async () => {
    let getFileCalls = 0
    const file = new File([csvBytes], 'seam.json')
    const source = new BrowserFileSource({
      fileSystemHandle: fakeFileSystemFileHandle(file, () => {
        getFileCalls += 1
      }),
    })

    const first = await source.getFile()
    const second = await source.getFile()
    expect(first).toBe(file)
    expect(second).toBe(first)
    expect(getFileCalls).toBe(1) // the accessor shares the one-shot snapshot cache

    // Same snapshot the fallback path exposes.
    const fallbackSource = new BrowserFileSource({ file })
    await expect(fallbackSource.getFile()).resolves.toBe(file)
  })
})

describe('BrowserFileSource — deliberate acquisition retry semantics (B06)', () => {
  /** A handle whose `getFile()` calls are scripted per attempt. */
  function scriptedHandle(
    script: readonly (() => Promise<File>)[],
    onCall?: (attempt: number) => void,
  ): { handle: FileSystemFileHandle; attempts: () => number } {
    let attempt = 0
    const handle: FileSystemFileHandle = {
      kind: 'file',
      name: 'scripted.csv',
      getFile: () => {
        attempt += 1
        onCall?.(attempt)
        const step = script[attempt - 1]
        return step === undefined
          ? Promise.reject(new Error(`unexpected acquisition attempt ${String(attempt)}`))
          : step()
      },
      isSameEntry: async () => false,
      createWritable: async () => {
        throw new Error('createWritable is not part of the read-only source contract')
      },
    }
    return { handle, attempts: () => attempt }
  }

  function deferred<T>(): {
    promise: Promise<T>
    resolve: (value: T) => void
    reject: (reason: unknown) => void
  } {
    let resolve!: (value: T) => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }

  /** Let every queued microtask AND a macrotask turn run. */
  function settleTurns(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0))
  }

  async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
    try {
      await promise
    } catch (error) {
      return error
    }
    return null
  }

  test('concurrent open()/metadata()/getFile() share one in-flight attempt and all see its failure', async () => {
    const pending = deferred<File>()
    const { handle, attempts } = scriptedHandle([() => pending.promise])
    const source = new BrowserFileSource({ fileSystemHandle: handle })

    const opened = source.open()
    const meta = source.metadata()
    const got = source.getFile()
    expect(attempts()).toBe(1) // one attempt, shared by all three callers

    pending.reject(new Error('NotAllowedError: permission revoked'))
    const errors = [await rejectionOf(opened), await rejectionOf(meta), await rejectionOf(got)]
    for (const [index, error] of errors.entries()) {
      expect(error, `caller ${String(index)} must observe the shared failure`).toBeInstanceOf(Error)
      expect((error as Error).message).toContain('permission revoked')
    }
    expect(attempts()).toBe(1) // observing the failure starts no extra attempt
  })

  test('the next call after a failed attempt retries exactly once, and concurrent retries share it', async () => {
    const file = new File([csvBytes], 'retry.csv')
    const pendingRetry = deferred<File>()
    const { handle, attempts } = scriptedHandle([
      () => Promise.reject(new Error('NotFoundError: file moved')),
      () => pendingRetry.promise,
    ])
    const source = new BrowserFileSource({ fileSystemHandle: handle })

    await expect(source.open()).rejects.toThrow(/NotFoundError/)
    expect(attempts()).toBe(1)

    // Retry: the next call acquires again — and a caller that joins while the
    // retry is in flight shares that retry rather than starting a third one.
    const retried = source.open()
    const alsoRetried = source.metadata()
    expect(attempts()).toBe(2)

    pendingRetry.resolve(file)
    const handleAfterRetry = await retried
    await expect(alsoRetried).resolves.toEqual({ format: 'csv', sizeBytes: csvBytes.byteLength })
    expect(handleAfterRetry.sourceId).toBe(source.id)
    expect(Object.isFrozen(handleAfterRetry)).toBe(true)
    expect(attempts()).toBe(2)
  })

  test('a fulfilled attempt is retained for the instance lifetime — never re-fetched, even if the handle now serves other bytes', async () => {
    const original = new File([csvBytes], 'snapshot.csv')
    const replaced = new File([new Uint8Array([9, 9, 9, 9, 9])], 'snapshot.csv')
    const { handle, attempts } = scriptedHandle([
      () => Promise.resolve(original),
      () => Promise.resolve(replaced),
    ])
    const source = new BrowserFileSource({ fileSystemHandle: handle })

    const first = await source.open()
    expect(await source.getFile()).toBe(original)
    expect(await source.getFile()).toBe(original)
    await expect(source.metadata()).resolves.toEqual({
      format: 'csv',
      sizeBytes: csvBytes.byteLength,
    })
    expect(await source.open()).toBe(first) // same frozen handle object
    expect(attempts()).toBe(1)
  })

  test('an old rejection cannot clear a newer in-flight attempt', async () => {
    const file = new File([csvBytes], 'stale.csv')
    const first = deferred<File>()
    const second = deferred<File>()
    const { handle, attempts } = scriptedHandle([() => first.promise, () => second.promise])
    const source = new BrowserFileSource({ fileSystemHandle: handle })

    const doomed = source.open()
    first.reject(new Error('first attempt failed'))
    await expect(doomed).rejects.toThrow(/first attempt failed/)
    expect(attempts()).toBe(1)

    // Attempt 2 starts and stays in flight across several turns: any late or
    // unconditional clear queued by attempt 1's rejection would drop it here.
    const retried = source.open()
    await settleTurns()
    await settleTurns()
    expect(attempts()).toBe(2)

    // A caller joining now must still share attempt 2 (not start a third).
    const joined = source.getFile()
    expect(attempts()).toBe(2)

    second.resolve(file)
    await expect(retried).resolves.toEqual({ kind: 'data-handle', sourceId: source.id })
    await expect(joined).resolves.toBe(file)
    expect(attempts()).toBe(2)
  })

  test('a synchronous getFile() throw becomes the attempt rejection (never a synchronous throw) and is retried', async () => {
    const file = new File([csvBytes], 'sync-throw.csv')
    let attempt = 0
    const handle: FileSystemFileHandle = {
      kind: 'file',
      name: 'sync-throw.csv',
      getFile: () => {
        attempt += 1
        if (attempt === 1) throw new Error('SecurityError: synchronous failure')
        return Promise.resolve(file)
      },
      isSameEntry: async () => false,
      createWritable: async () => {
        throw new Error('createWritable is not part of the read-only source contract')
      },
    }
    const source = new BrowserFileSource({ fileSystemHandle: handle })

    // The accessor must return a promise in both paths — a throw here would
    // escape the shared attempt cache as a raw synchronous error.
    let promise: Promise<File> | null = null
    expect(() => {
      promise = source.getFile()
    }).not.toThrow()
    await expect(promise!).rejects.toThrow(/SecurityError/)
    expect(attempt).toBe(1)

    // Same retry contract: the next call acquires again and succeeds.
    await expect(source.getFile()).resolves.toBe(file)
    expect(attempt).toBe(2)
    await expect(source.metadata()).resolves.toEqual({
      format: 'csv',
      sizeBytes: csvBytes.byteLength,
    })
    expect(attempt).toBe(2)
  })

  test('the fallback path never invokes a handle and never reads dataset bytes', async () => {
    const file = new File([csvBytes], 'fallback.csv')
    let byteReads = 0
    const countRead = (): never => {
      byteReads += 1
      throw new Error('the read-only source must not read dataset bytes')
    }
    // Any byte-level accessor is a contract violation on this path.
    Object.assign(file, {
      arrayBuffer: countRead,
      text: countRead,
      slice: countRead,
      stream: countRead,
    })

    const source = new BrowserFileSource({ file })
    await expect(source.getFile()).resolves.toBe(file)
    await expect(source.open()).resolves.toEqual({ kind: 'data-handle', sourceId: source.id })
    await expect(source.metadata()).resolves.toEqual({
      format: 'csv',
      sizeBytes: csvBytes.byteLength,
    })
    expect(byteReads).toBe(0)
  })

  test('a failed acquisition never logs the source or file name (ADR 0025)', async () => {
    const fileName = 'do-not-log-me-9f2b.csv'
    const err = new Error('NotAllowedError: permission revoked')
    const { handle } = scriptedHandle([() => Promise.reject(err), () => Promise.reject(err)])
    const source = new BrowserFileSource({ fileSystemHandle: handle })

    const channels = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const
    const observers = channels.map((channel) =>
      vi.spyOn(console, channel).mockImplementation(() => undefined),
    )
    try {
      await rejectionOf(source.open())
      await rejectionOf(source.open()) // the retry path too
    } finally {
      for (const observer of observers) observer.mockRestore()
    }

    const logged = observers
      .flatMap((observer) =>
        observer.mock.calls.map((args) => args.map((argument) => String(argument)).join(' ')),
      )
      .join('\n')
    expect(logged).not.toContain(fileName)
    expect(logged).not.toContain(source.id)
    expect(logged).not.toContain('scripted.csv')
  })
})
