// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { CONTRACT_TOO_LARGE_MESSAGE, MAX_CONTRACT_BYTES, readContractFile } from './contract-import'
import { parseContract } from '@assay/contracts'

/**
 * Unit pins for the contract-import boundary: the size bound is checked
 * from the file's metadata BEFORE any byte is read, a read returns the text
 * that `parseContract` (the m5-0 total parser) then judges, and a read
 * failure degrades to a typed outcome instead of a raw throw.
 *
 * D01 — the success discriminant is `'read'`, because this function reads. A
 * contract that does not parse is still a successful READ followed by a typed
 * downstream parse refusal; nothing here claims a parsed contract.
 */
describe('readContractFile', () => {
  it('accepts a small YAML file as text', async () => {
    const file = { size: 42, text: async () => 'format: v1\nname: c\nversion: 1\n' }
    const result = await readContractFile(file)
    expect(result.kind).toBe('read')
    if (result.kind === 'read') {
      const parsed = parseContract(result.text)
      expect(parsed.ok).toBe(true)
    }
  })

  it('names the success outcome for the READ, not for a parse result', async () => {
    // Pins the discriminant itself: a revert to `'parsed'` would claim this
    // function understood the contract, which it never does (D01).
    const result = await readContractFile({ size: 3, text: async () => 'x: 1' })
    expect(result.kind).toBe('read')
    expect(Object.keys(result).sort()).toEqual(['kind', 'text'])
  })

  it('is a successful read even when the text will not parse downstream', async () => {
    // Invalid YAML: the read succeeded, and the TYPE of the failure is the
    // downstream parser's (a typed refusal with line/column provenance), not
    // a read failure. That split is the whole point of the rename.
    const text = 'format: v1\ncolumns: not-a-list\n'
    const result = await readContractFile({ size: text.length, text: async () => text })
    expect(result.kind).toBe('read')
    if (result.kind !== 'read') return
    const parsed = parseContract(result.text)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.errors.length).toBeGreaterThan(0)
    expect(parsed.errors[0]).toMatchObject({ line: expect.any(Number), column: expect.any(Number) })
  })

  it('rejects an over-bound file from metadata alone (text() never called)', async () => {
    let read = false
    const file = {
      size: MAX_CONTRACT_BYTES + 1,
      text: async () => {
        read = true
        return 'format: v1\n'
      },
    }
    const result = await readContractFile(file)
    expect(result).toEqual({ kind: 'too-large' })
    expect(read).toBe(false)
    expect(CONTRACT_TOO_LARGE_MESSAGE).toContain('1 MiB')
  })

  it('degrades a read failure to a typed outcome (never a throw)', async () => {
    const file = {
      size: 10,
      text: async () => {
        throw new Error('the handle was revoked')
      },
    }
    const result = await readContractFile(file)
    expect(result).toEqual({ kind: 'read-failed', message: 'the handle was revoked' })
  })

  it('reads a file exactly at the bound (the bound is exclusive >)', async () => {
    const file = { size: MAX_CONTRACT_BYTES, text: async () => 'x' }
    const result = await readContractFile(file)
    expect(result.kind).toBe('read')
  })

  it('reads a file one byte under the bound too (the bound is not off by one)', async () => {
    let read = false
    const file = {
      size: MAX_CONTRACT_BYTES - 1,
      text: async () => {
        read = true
        return 'format: v1\n'
      },
    }
    await expect(readContractFile(file)).resolves.toMatchObject({ kind: 'read' })
    expect(read).toBe(true)
  })
})
