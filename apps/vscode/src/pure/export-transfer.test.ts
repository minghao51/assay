// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { acceptExportFrame, EXPORT_CHUNK_BYTES } from './export-transfer'

const state = { id: 'request-1', generation: 3, totalBytes: 3, nextSequence: 0, nextOffset: 0 }
const frame = {
  kind: 'export-chunk',
  id: 'request-1',
  generation: 3,
  sequence: 0,
  offset: 0,
  totalBytes: 3,
  bytes: [1, 2, 3],
}

describe('export frame validation', () => {
  it('accepts only correlated contiguous bounded chunks', () => {
    const accepted = acceptExportFrame(state, frame)
    expect([...accepted.bytes]).toEqual([1, 2, 3])
    expect(accepted.state.nextOffset).toBe(3)
    for (const invalid of [
      { ...frame, id: 'late' },
      { ...frame, generation: 2 },
      { ...frame, sequence: 1 },
      { ...frame, offset: 1 },
      { ...frame, bytes: [1, 256] },
      { ...frame, bytes: Array.from({ length: EXPORT_CHUNK_BYTES + 1 }, () => 0) },
    ])
      expect(() => acceptExportFrame(state, invalid)).toThrow('invalid-frame')
  })
})
