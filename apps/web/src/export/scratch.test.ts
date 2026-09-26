// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { readOpfsBytes } from './scratch'
import type { ScratchDirectoryHandle, ScratchFileHandle, ScratchScope } from './scratch'

/** A tiny in-memory OPFS-like tree: directories hold directories/files. */
function fakeFile(bytes: number[]): ScratchFileHandle {
  return { getFile: async () => new Blob([new Uint8Array(bytes)]) }
}

function fakeScope(tree: Record<string, ScratchDirectoryHandle>): ScratchScope {
  return { getDirectory: async () => tree['']! }
}

function directory(entries: Record<string, ScratchDirectoryHandle | ScratchFileHandle>) {
  return {
    getDirectoryHandle: async (name: string): Promise<ScratchDirectoryHandle> => {
      const entry = entries[name]
      if (entry === undefined || !('getDirectoryHandle' in entry)) {
        throw new Error(`no directory ${name}`)
      }
      return entry
    },
    getFileHandle: async (name: string): Promise<ScratchFileHandle> => {
      const entry = entries[name]
      if (entry === undefined || 'getDirectoryHandle' in entry) {
        throw new Error(`no file ${name}`)
      }
      return entry
    },
  }
}

describe('readOpfsBytes — navigates the engine scratch path', () => {
  it('reads the bytes at a nested relative path', async () => {
    const exports = directory({
      'assay-export-1.csv': fakeFile([1, 2, 3]),
    })
    const scope = fakeScope({ '': directory({ 'assay-exports': exports }) })
    const bytes = await readOpfsBytes('assay-exports/assay-export-1.csv', scope)
    expect(Array.from(bytes)).toEqual([1, 2, 3])
  })

  it('tolerates leading/trailing slashes but resolves nothing it cannot see', async () => {
    const exports = directory({ 'x.jsonl': fakeFile([9]) })
    const scope = fakeScope({ '': directory({ 'assay-exports': exports }) })
    expect(Array.from(await readOpfsBytes('/assay-exports/x.jsonl/', scope))).toEqual([9])
    await expect(readOpfsBytes('assay-exports/missing.jsonl', scope)).rejects.toThrow(
      'no file missing.jsonl',
    )
  })

  it('rejects an empty path instead of fabricating bytes', async () => {
    const scope = fakeScope({ '': directory({}) })
    await expect(readOpfsBytes('///', scope)).rejects.toThrow('the export path was empty')
  })
})
