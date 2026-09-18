import { describe, expect, it, vi } from 'vitest'
import { detectSaveCapabilities, requestSaveDestination, writeExportCopy } from './save-destination'
import type { SaveFileHandle } from './save-destination'

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
