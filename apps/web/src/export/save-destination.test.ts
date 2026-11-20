// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from 'vitest'
import { detectSaveCapabilities, requestSaveDestination, writeExportCopy } from './save-destination'
import type { SaveFileHandle, SaveWritable, SourceIdentity } from './save-destination'

function fakeHandle(writes: Uint8Array[]): SaveFileHandle {
  return {
    createWritable: async () => ({
      write: async (chunk) => {
        writes.push(chunk)
      },
      close: async () => undefined,
    }),
  }
}

/** Identity whose authoritative verdict is fixed (an FSA-opened source). */
function fsaIdentity(sameEntry: boolean | Error): SourceIdentity {
  return {
    isSameEntry: async () => {
      if (sameEntry instanceof Error) throw sameEntry
      return sameEntry
    },
  }
}

function abortError(): Error {
  const error = new Error('user cancelled')
  error.name = 'AbortError'
  return error
}

describe('detectSaveCapabilities — existence only, no user data', () => {
  it('reports the save picker only when it is a function', () => {
    expect(detectSaveCapabilities({ showSaveFilePicker: () => undefined })).toEqual({
      fileSavePicker: true,
    })
    expect(detectSaveCapabilities({})).toEqual({ fileSavePicker: false })
    expect(detectSaveCapabilities({ showSaveFilePicker: 'nope' })).toEqual({
      fileSavePicker: false,
    })
  })
})

describe('requestSaveDestination — established picker patterns', () => {
  it('takes the download fallback when the save picker is unavailable', async () => {
    await expect(
      requestSaveDestination('csv', { capabilities: { fileSavePicker: false } }),
    ).resolves.toEqual({ via: 'download' })
  })

  it('asks the save picker with a privacy-safe suggested name and returns the handle', async () => {
    const handle = fakeHandle([])
    const pick = vi.fn(async () => handle)
    const destination = await requestSaveDestination('jsonl', {
      capabilities: { fileSavePicker: true },
      showSaveFilePicker: pick,
      // FSA-opened source, provably a different entry — the only session
      // shape still offered the picker (m4-5 fix round 2).
      sourceIdentity: fsaIdentity(false),
    })
    expect(destination).toEqual({ via: 'file-system-access', handle })
    // Engine-generated-looking name; never the opened source's name (ADR 0025).
    expect(pick).toHaveBeenCalledWith({ suggestedName: 'assay-export.jsonl' })
  })

  it('resolves null when the user dismisses the picker (AbortError)', async () => {
    await expect(
      requestSaveDestination('parquet', {
        capabilities: { fileSavePicker: true },
        showSaveFilePicker: async () => {
          throw abortError()
        },
        sourceIdentity: fsaIdentity(false),
      }),
    ).resolves.toBeNull()
  })

  it('propagates a non-cancel picker failure so it can be surfaced readably', async () => {
    await expect(
      requestSaveDestination('parquet', {
        capabilities: { fileSavePicker: true },
        showSaveFilePicker: async () => {
          throw new Error('security error')
        },
        sourceIdentity: fsaIdentity(false),
      }),
    ).rejects.toThrow('security error')
  })
})

describe('requestSaveDestination — input-fallback sessions are download-only (m4-5 fix round 2)', () => {
  it('never offers the direct-write picker when the opened source has no retained FSA handle', async () => {
    // Regression pin for the reviewer's round-2 finding: round 1 let an
    // input-fallback session use the save picker behind a
    // name+size+lastModified suspicion — which a source externally touched
    // after opening defeats (different mtime ⇒ same-entry write allowed).
    // Without a retained FSA handle, identity cannot be proven, so the
    // picker is not offered AT ALL: the destination is the anchor download
    // (our code never acquires a writable; the browser manages the target).
    // The stub below throws if the picker is ever invoked.
    const pick = vi.fn(async () => {
      throw new Error('the save picker must never be offered to an input-fallback session')
    })
    const destination = await requestSaveDestination('csv', {
      capabilities: { fileSavePicker: true },
      showSaveFilePicker: pick,
      // No `sourceIdentity`: the hidden-input open retained no handle.
    })
    expect(destination).toEqual({ via: 'download' })
    expect(pick).not.toHaveBeenCalled()
  })
})

describe('requestSaveDestination — same-source refusal for FSA-opened sources', () => {
  it('refuses the destination when the picked handle IS the opened source, before any write', async () => {
    // Regression pin for the ADR 0012 data-loss path: a real FSA probe opened
    // a source and saved the export to the SAME OPFS handle, silently
    // replacing the source. Here the picker returns the same entry; the
    // destination request must refuse, and no byte can have been written
    // (the writable was never even acquired — this is request time, before
    // the engine export is attempted at all).
    const writes: Uint8Array[] = []
    const handle = fakeHandle(writes)
    const destination = await requestSaveDestination('csv', {
      capabilities: { fileSavePicker: true },
      showSaveFilePicker: async () => handle,
      sourceIdentity: fsaIdentity(true),
    })
    expect(destination).toEqual({ via: 'refused-source' })
    expect(writes).toHaveLength(0)
  })

  it('lets a provably different destination through with its handle', async () => {
    const writes: Uint8Array[] = []
    const handle = fakeHandle(writes)
    const destination = await requestSaveDestination('parquet', {
      capabilities: { fileSavePicker: true },
      showSaveFilePicker: async () => handle,
      sourceIdentity: fsaIdentity(false),
    })
    expect(destination).toEqual({ via: 'file-system-access', handle })
  })

  it('fails closed when the authoritative same-entry verdict cannot be obtained', async () => {
    // A refused lookalike costs the user a re-pick; a wrongly allowed
    // same-entry write destroys the opened file. Doubt refuses.
    const destination = await requestSaveDestination('csv', {
      capabilities: { fileSavePicker: true },
      showSaveFilePicker: async () => fakeHandle([]),
      sourceIdentity: fsaIdentity(new Error('handle disconnected')),
    })
    expect(destination).toEqual({ via: 'refused-source' })
  })
})

/** The engine's scratch result shape the helper reads from. */
const result = {
  path: 'assay-exports/assay-export-1.csv',
  format: 'csv',
  rowCount: 6,
  bytes: 3,
} as const

describe('writeExportCopy — reads OPFS scratch and delivers to the destination', () => {
  it('writes the OPFS bytes into a picked handle and reports the strategy', async () => {
    const writes: Uint8Array[] = []
    const readBytes = vi.fn(async () => new Uint8Array([1, 2, 3]))
    const strategy = await writeExportCopy(
      { via: 'file-system-access', handle: fakeHandle(writes) },
      result,
      { readBytes },
    )
    expect(strategy).toBe('file-system-access')
    expect(readBytes).toHaveBeenCalledWith('assay-exports/assay-export-1.csv')
    expect(Array.from(writes[0]!)).toEqual([1, 2, 3])
  })

  it('delivers a typed blob download on the fallback path', async () => {
    const delivered: { name: string; type: string; size: number }[] = []
    const strategy = await writeExportCopy({ via: 'download' }, result, {
      readBytes: async () => new Uint8Array([1, 2, 3]),
      deliverDownload: (blob, name) => {
        delivered.push({ name, type: blob.type, size: blob.size })
      },
    })
    expect(strategy).toBe('download')
    expect(delivered).toEqual([{ name: 'assay-export.csv', type: 'text/csv', size: 3 }])
  })

  it('propagates a scratch read failure so the caller can report it', async () => {
    await expect(
      writeExportCopy({ via: 'download' }, result, {
        readBytes: async () => {
          throw new Error('scratch entry missing')
        },
      }),
    ).rejects.toThrow('scratch entry missing')
  })
})

/**
 * B03 — a controllable writable: the call ORDER it saw, plus an optional
 * injected failure per method. `abort` may be `'absent'` (a writable that
 * does not support it at all), which is what keeps the helper's ownership of
 * the failure explicit instead of assumed.
 */
type WritableCall = 'write' | 'close' | 'abort'

interface WritablePlan {
  readonly write?: Error
  readonly close?: Error
  /** `'absent'` omits the optional method; an Error makes the abort itself fail. */
  readonly abort?: Error | 'absent'
}

interface WritableProbe {
  readonly handle: SaveFileHandle
  readonly calls: WritableCall[]
  readonly abortReasons: unknown[]
  readonly writes: Uint8Array[]
  readonly createCalls: () => number
}

function probeWritable(plan: WritablePlan = {}): WritableProbe {
  const calls: WritableCall[] = []
  const abortReasons: unknown[] = []
  const writes: Uint8Array[] = []
  let created = 0
  const handle: SaveFileHandle = {
    createWritable: async () => {
      created += 1
      const writable: Record<string, unknown> = {
        write: async (chunk: Uint8Array<ArrayBuffer>) => {
          calls.push('write')
          if (plan.write !== undefined) throw plan.write
          writes.push(chunk)
        },
        close: async () => {
          calls.push('close')
          if (plan.close !== undefined) throw plan.close
        },
      }
      if (plan.abort !== 'absent') {
        writable['abort'] = async (reason?: unknown) => {
          calls.push('abort')
          abortReasons.push(reason)
          if (plan.abort instanceof Error) throw plan.abort
        }
      }
      return writable as unknown as SaveWritable
    },
  }
  return { handle, calls, abortReasons, writes, createCalls: () => created }
}

const bytes = new Uint8Array([1, 2, 3])

describe('writeExportCopy — the writable failure lifecycle (B03)', () => {
  it('reads first: a read failure never creates or touches a writable', async () => {
    const readError = new Error('scratch entry missing')
    const probe = probeWritable()
    const rejection = writeExportCopy({ via: 'file-system-access', handle: probe.handle }, result, {
      readBytes: async () => {
        throw readError
      },
    })
    await expect(rejection).rejects.toBe(readError)
    expect(probe.createCalls()).toBe(0)
    expect(probe.calls).toEqual([])
  })

  it('propagates a createWritable failure without calling methods on a missing writable', async () => {
    const createError = new Error('the picker handle was disconnected')
    const calls: WritableCall[] = []
    const handle: SaveFileHandle = {
      createWritable: async () => {
        throw createError
      },
    }
    await expect(
      writeExportCopy({ via: 'file-system-access', handle }, result, {
        readBytes: async () => bytes,
      }),
    ).rejects.toBe(createError)
    expect(calls).toEqual([])
  })

  it('aborts once after a failed write and keeps the write failure as the rejection', async () => {
    const writeError = new Error('write failed')
    const probe = probeWritable({ write: writeError })
    await expect(
      writeExportCopy({ via: 'file-system-access', handle: probe.handle }, result, {
        readBytes: async () => bytes,
      }),
    ).rejects.toBe(writeError)
    // No close after a failed write (never a success path), one abort.
    expect(probe.calls).toEqual(['write', 'abort'])
    expect(probe.abortReasons).toHaveLength(1)
  })

  it('does not replace the primary rejection when abort itself fails', async () => {
    const writeError = new Error('write failed')
    const abortError = new Error('abort failed')
    const probe = probeWritable({ write: writeError, abort: abortError })
    await expect(
      writeExportCopy({ via: 'file-system-access', handle: probe.handle }, result, {
        readBytes: async () => bytes,
      }),
    ).rejects.toBe(writeError)
    expect(probe.calls).toEqual(['write', 'abort'])
  })

  it('still rejects with the write failure when the writable has no abort', async () => {
    const writeError = new Error('write failed')
    const probe = probeWritable({ write: writeError, abort: 'absent' })
    await expect(
      writeExportCopy({ via: 'file-system-access', handle: probe.handle }, result, {
        readBytes: async () => bytes,
      }),
    ).rejects.toBe(writeError)
    expect(probe.calls).toEqual(['write'])
  })

  it('aborts after a close failure, best effort, keeping the close failure', async () => {
    const closeError = new Error('close failed')
    const probe = probeWritable({ close: closeError })
    await expect(
      writeExportCopy({ via: 'file-system-access', handle: probe.handle }, result, {
        readBytes: async () => bytes,
      }),
    ).rejects.toBe(closeError)
    expect(probe.calls).toEqual(['write', 'close', 'abort'])
  })

  it('closes exactly once and never aborts on the success path', async () => {
    const probe = probeWritable()
    await expect(
      writeExportCopy({ via: 'file-system-access', handle: probe.handle }, result, {
        readBytes: async () => bytes,
      }),
    ).resolves.toBe('file-system-access')
    expect(probe.calls).toEqual(['write', 'close'])
    expect(probe.abortReasons).toEqual([])
    expect(probe.createCalls()).toBe(1)
  })

  it('hands abort a value-free reason, never the primary error or a path', async () => {
    const writeError = new Error(`COPY failed for ${result.path}`)
    const probe = probeWritable({ write: writeError })
    await expect(
      writeExportCopy({ via: 'file-system-access', handle: probe.handle }, result, {
        readBytes: async () => bytes,
      }),
    ).rejects.toBe(writeError)
    const reason = probe.abortReasons[0]
    expect(reason).not.toBe(writeError)
    expect(typeof reason).toBe('string')
    expect(String(reason)).not.toContain(result.path)
    expect(String(reason)).not.toContain('COPY')
  })

  it('propagates a download-delivery failure on the fallback path', async () => {
    const deliveryError = new Error('the anchor click was blocked')
    await expect(
      writeExportCopy({ via: 'download' }, result, {
        readBytes: async () => bytes,
        deliverDownload: () => {
          throw deliveryError
        },
      }),
    ).rejects.toBe(deliveryError)
  })
})
