import { describe, expect, it, vi } from 'vitest'
import { detectSaveCapabilities, requestSaveDestination, writeExportCopy } from './save-destination'
import type { SaveFileHandle, SourceIdentity } from './save-destination'

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

/** A handle whose `getFile` resolves the given probe file (DOM handles do). */
function fakeHandleWithFile(writes: Uint8Array[], file: File): SaveFileHandle {
  return {
    ...fakeHandle(writes),
    getFile: async () => file,
  }
}

/** Identity whose authoritative verdict is fixed. */
function provableIdentity(sameEntry: boolean | Error): SourceIdentity {
  return {
    kind: 'provable',
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
      }),
    ).rejects.toThrow('security error')
  })
})

describe('requestSaveDestination — same-source refusal (m4-5 fix round)', () => {
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
      sourceIdentity: provableIdentity(true),
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
      sourceIdentity: provableIdentity(false),
    })
    expect(destination).toEqual({ via: 'file-system-access', handle })
  })

  it('fails closed when the authoritative same-entry verdict cannot be obtained', async () => {
    // A refused lookalike costs the user a re-pick; a wrongly allowed
    // same-entry write destroys the opened file. Doubt refuses.
    const destination = await requestSaveDestination('csv', {
      capabilities: { fileSavePicker: true },
      showSaveFilePicker: async () => fakeHandle([]),
      sourceIdentity: provableIdentity(new Error('handle disconnected')),
    })
    expect(destination).toEqual({ via: 'refused-source' })
  })

  it('suspects a file-matching identity from name+size+lastModified and refuses the match', async () => {
    // The hidden-input fallback has no handle, so identity is only ever a
    // suspicion — but a save picker aimed at a file matching the opened
    // source's name, size, and mtime must still be refused.
    const writes: Uint8Array[] = []
    const probeFile = new File([new Uint8Array(682)], 'customers.parquet', {
      lastModified: 1_700_000_000_000,
    })
    const destination = await requestSaveDestination('csv', {
      capabilities: { fileSavePicker: true },
      showSaveFilePicker: async () => fakeHandleWithFile(writes, probeFile),
      sourceIdentity: {
        kind: 'file-matching',
        name: 'customers.parquet',
        size: 682,
        lastModified: 1_700_000_000_000,
      },
    })
    expect(destination).toEqual({ via: 'refused-source' })
    expect(writes).toHaveLength(0)
  })

  it('allows a destination whose probe differs from the file-matching identity', async () => {
    const writes: Uint8Array[] = []
    const probeFile = new File([new Uint8Array(100)], 'elsewhere.csv', { lastModified: 5 })
    const destination = await requestSaveDestination('csv', {
      capabilities: { fileSavePicker: true },
      showSaveFilePicker: async () => fakeHandleWithFile(writes, probeFile),
      sourceIdentity: {
        kind: 'file-matching',
        name: 'customers.parquet',
        size: 682,
        lastModified: 1_700_000_000_000,
      },
    })
    expect(destination?.via).toBe('file-system-access')
  })

  it('does not fabricate a suspicion when the handle exposes no file to probe', async () => {
    const destination = await requestSaveDestination('csv', {
      capabilities: { fileSavePicker: true },
      showSaveFilePicker: async () => fakeHandle([]), // no getFile
      sourceIdentity: {
        kind: 'file-matching',
        name: 'customers.parquet',
        size: 682,
        lastModified: 1,
      },
    })
    expect(destination?.via).toBe('file-system-access')
  })

  it('stays out of the way when no source identity is known', async () => {
    const destination = await requestSaveDestination('jsonl', {
      capabilities: { fileSavePicker: true },
      showSaveFilePicker: async () => fakeHandle([]),
    })
    expect(destination?.via).toBe('file-system-access')
  })
})

describe('writeExportCopy — reads OPFS scratch and delivers to the destination', () => {
  const result = {
    path: 'assay-exports/assay-export-1.csv',
    format: 'csv',
    rowCount: 6,
    bytes: 3,
  } as const

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
