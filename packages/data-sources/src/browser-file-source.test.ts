// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'vitest'
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
