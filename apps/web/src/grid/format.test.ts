import { describe, expect, it } from 'vitest'
import { formatCell } from './format'

describe('formatCell (total, deterministic DOM projection of cell values)', () => {
  it('formats scalars through String()', () => {
    expect(formatCell(123456n)).toBe('123456')
    expect(formatCell(1.5)).toBe('1.5')
    expect(formatCell('row-7')).toBe('row-7')
    expect(formatCell(false)).toBe('false')
  })

  it('renders NULL as an empty cell (row data-status distinguishes placeholders)', () => {
    expect(formatCell(null)).toBe('')
    expect(formatCell(undefined)).toBe('')
  })

  it('formats timestamps as ISO strings', () => {
    expect(formatCell(new Date('2026-01-02T03:04:05.000Z'))).toBe('2026-01-02T03:04:05.000Z')
  })

  it('summarizes binary values without dumping bytes', () => {
    expect(formatCell(new Uint8Array([1, 2, 3]))).toBe('<3 bytes>')
  })

  it('formats nested struct/list values as compact JSON', () => {
    expect(formatCell({ name: 'n1', tags: ['x', 'y'] })).toBe('{"name":"n1","tags":["x","y"]}')
  })
})
