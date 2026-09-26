// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'vitest'
import { BrowserFileSource } from './browser-file-source'
import { pickDataFile } from './pick-file'
import type { BrowserFileSystemCapabilities } from './capabilities'

const csvBytes = new TextEncoder().encode('a,b\n1,2\n')

const withFilePicker: BrowserFileSystemCapabilities = {
  filePicker: true,
  dataTransferHandle: true,
}
const withoutFilePicker: BrowserFileSystemCapabilities = {
  filePicker: false,
  dataTransferHandle: false,
}

function fakeHandle(file: File): FileSystemFileHandle {
  return {
    kind: 'file',
    name: file.name,
    getFile: async () => file,
    isSameEntry: async () => false,
    createWritable: async () => {
      throw new Error('not used')
    },
  }
}

describe('pickDataFile — File System Access branch', () => {
  test('wraps the returned handle in a usable BrowserFileSource', async () => {
    const file = new File([csvBytes], 'picked.csv')
    const pickerCalls: Array<unknown> = []
    const picked = await pickDataFile({
      capabilities: withFilePicker,
      showOpenFilePicker: async (options) => {
        pickerCalls.push(options)
        return [fakeHandle(file)]
      },
    })

    expect(picked?.via).toBe('file-system-access')
    expect(picked?.source).toBeInstanceOf(BrowserFileSource)
    await expect(picked?.source.metadata()).resolves.toEqual({
      format: 'csv',
      sizeBytes: csvBytes.byteLength,
    })
    // Single-file picker: multiple is always false.
    expect(pickerCalls).toEqual([{ multiple: false }])
  })

  test('resolves null when the user cancels the native dialog (AbortError)', async () => {
    const picked = await pickDataFile({
      capabilities: withFilePicker,
      showOpenFilePicker: async () => {
        throw new DOMException('user aborted the picker', 'AbortError')
      },
    })
    expect(picked).toBeNull()
  })

  test('resolves null when the picker resolves no handle, without touching the source', async () => {
    const picked = await pickDataFile({
      capabilities: withFilePicker,
      showOpenFilePicker: async () => [],
    })
    expect(picked).toBeNull()
  })

  test('propagates non-abort picker failures', async () => {
    await expect(
      pickDataFile({
        capabilities: withFilePicker,
        showOpenFilePicker: async () => {
          throw new TypeError('security error')
        },
      }),
    ).rejects.toThrow(TypeError)
  })
})

describe('pickDataFile — hidden-input fallback branch', () => {
  test('is selected when the File System Access picker is unavailable', async () => {
    const file = new File([csvBytes], 'fallback.csv')
    const picked = await pickDataFile({
      capabilities: withoutFilePicker,
      pickViaHiddenInput: async () => file,
    })

    expect(picked?.via).toBe('input-fallback')
    expect(picked?.source).toBeInstanceOf(BrowserFileSource)
    if (picked === null) throw new Error('expected a picked file on the fallback path')
    await expect(picked.source.open()).resolves.toEqual({
      kind: 'data-handle',
      sourceId: picked.source.id,
    })
    await expect(picked.source.metadata()).resolves.toEqual({
      format: 'csv',
      sizeBytes: csvBytes.byteLength,
    })
  })

  test('resolves null when the user cancels the input dialog', async () => {
    const picked = await pickDataFile({
      capabilities: withoutFilePicker,
      pickViaHiddenInput: async () => null,
    })
    expect(picked).toBeNull()
  })

  test('fails with a clear error when no DOM and no injection is available', async () => {
    await expect(pickDataFile({ capabilities: withoutFilePicker })).rejects.toThrow(
      /input fallback needs a DOM document/,
    )
  })
})
