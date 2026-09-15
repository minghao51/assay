import { describe, expect, test } from 'vitest'
import { detectFileSystemCapabilities } from './capabilities'

/** Scope shaped like a Chromium global (both APIs present as functions). */
const chromiumLikeScope = {
  showOpenFilePicker: () => {},
  DataTransferItem: { prototype: { getAsFileSystemHandle: () => {} } },
}

/** Scope shaped like a bare Node global (neither API exists). */
const nodeLikeScope = {}

describe('detectFileSystemCapabilities', () => {
  test('detects both APIs on a Chromium-like scope', () => {
    expect(detectFileSystemCapabilities(chromiumLikeScope)).toEqual({
      filePicker: true,
      dataTransferHandle: true,
    })
  })

  test('reports no capabilities for a Node-like scope', () => {
    expect(detectFileSystemCapabilities(nodeLikeScope)).toEqual({
      filePicker: false,
      dataTransferHandle: false,
    })
  })

  test('treats the APIs independently (Firefox/older-Chromium mixes)', () => {
    // showOpenFilePicker without getAsFileSystemHandle (e.g. Firefox with a
    // hypothetical picker shim, or older Chromium).
    expect(detectFileSystemCapabilities({ showOpenFilePicker: () => {} })).toEqual({
      filePicker: true,
      dataTransferHandle: false,
    })

    // DataTransferItem present but without the handle method (older Firefox).
    expect(
      detectFileSystemCapabilities({
        DataTransferItem: { prototype: {} },
      }),
    ).toEqual({ filePicker: false, dataTransferHandle: false })
  })

  test('requires the members to be functions, not just present', () => {
    expect(
      detectFileSystemCapabilities({
        showOpenFilePicker: 42,
        DataTransferItem: { prototype: { getAsFileSystemHandle: 'yes' } },
      }),
    ).toEqual({ filePicker: false, dataTransferHandle: false })
  })

  test('defaults to globalThis (in Node: no capabilities)', () => {
    // The Node test environment has neither API on globalThis; if this ever
    // runs in Chromium via the harness, both are true — either way the
    // detection must not throw and must agree with a manual probe.
    const caps = detectFileSystemCapabilities()
    expect(caps.filePicker).toBe(typeof globalThis.showOpenFilePicker === 'function')
    expect(caps.dataTransferHandle).toBe(
      typeof globalThis.DataTransferItem?.prototype.getAsFileSystemHandle === 'function',
    )
  })
})
