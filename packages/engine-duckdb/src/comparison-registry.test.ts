import { describe, expect, it } from 'vitest'
import { ComparisonRegistry, viewNameForComparisonId } from './comparison-registry'

describe('ComparisonRegistry (m6-2 single-slot staging)', () => {
  it('reserves engine-generated ids, view names, and file names', () => {
    const registry = new ComparisonRegistry()
    const first = registry.reserve('parquet')
    expect(first.comparisonId).toBe('d1')
    expect(first.viewName).toBe('assay_diff_d1')
    expect(first.registeredFileName).toBe('diff_d1')
    expect(viewNameForComparisonId('d2')).toBe('assay_diff_d2')
  })

  it('keeps exactly one staged comparison; a replacement discards the old', () => {
    const registry = new ComparisonRegistry()
    registry.confirm(registry.reserve('parquet'))
    expect(registry.get('d1')).not.toBeNull()
    expect(registry.viewNames()).toEqual(['assay_diff_d1'])

    const second = registry.reserve('csv')
    registry.confirm(second)
    expect(registry.get('d1')).toBeNull()
    expect(registry.get('d2')?.format).toBe('csv')
    expect(registry.viewNames()).toEqual(['assay_diff_d2'])
  })

  it('clear returns the staged entry and empties the slot (idempotent-safe)', () => {
    const registry = new ComparisonRegistry()
    registry.confirm(registry.reserve('jsonl'))
    expect(registry.clear()?.comparisonId).toBe('d1')
    expect(registry.clear()).toBeNull()
    expect(registry.current()).toBeNull()
    expect(registry.viewNames()).toEqual([])
  })
})
