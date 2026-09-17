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

  it('formats nested struct/list values through the bounded nested preview (m3-2)', () => {
    // Same compact JSON text as before for small values — but now bounded.
    expect(formatCell({ name: 'n1', tags: ['x', 'y'] })).toBe('{"name":"n1","tags":["x","y"]}')
    // Depth-aware: the depth-3 leaf elides with an honest marker.
    expect(formatCell({ a: { b: { c: 1 } } })).toBe('{"a":{"b":{"c":…}}}')
    // Length-capped: a huge value can never flood the cell or a tooltip.
    const capped = formatCell({ s: 'x'.repeat(500) })
    expect(capped.length).toBe(120)
    expect(capped.endsWith('…')).toBe(true)
  })

  it('renders raw Arrow list slices (array-like {length, get}) as arrays (m3-2)', () => {
    // m3-1 worker-boundary contract: list cells arrive as Vector slices, not
    // Arrays — the preview must read them positionally.
    const slice = { length: 2, get: (index: number) => ['x', 'y'][index] }
    expect(formatCell(slice)).toBe('["x","y"]')
  })
})
