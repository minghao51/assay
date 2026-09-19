import { describe, expect, it } from 'vitest'
import { CONTRACT_TOO_LARGE_MESSAGE, MAX_CONTRACT_BYTES, readContractFile } from './contract-import'
import { parseContract } from '@assay/contracts'

/**
 * Unit pins for the contract-import boundary: the size bound is checked
 * from the file's metadata BEFORE any byte is read, a valid read returns
 * the text that `parseContract` (the m5-0 total parser) then judges, and a
 * read failure degrades to a typed outcome instead of a raw throw.
 */
describe('readContractFile', () => {
  it('accepts a small YAML file as text', async () => {
    const file = { size: 42, text: async () => 'format: v1\nname: c\nversion: 1\n' }
    const result = await readContractFile(file)
    expect(result.kind).toBe('parsed')
    if (result.kind === 'parsed') {
      const parsed = parseContract(result.text)
      expect(parsed.ok).toBe(true)
    }
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
    expect(result.kind).toBe('parsed')
  })
})
