// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { TableRegistry, viewNameForTableId } from './table-registry'

describe('TableRegistry (M1-4 worker-side handle bookkeeping)', () => {
  it('assigns monotonic ids and engine-generated view/file names', () => {
    const registry = new TableRegistry()
    const first = registry.reserve('parquet')
    const second = registry.reserve('csv')

    expect(first.tableId).toBe('t1')
    expect(first.viewName).toBe('assay_t1')
    expect(first.registeredFileName).toBe('t1') // engine-generated: no user names in SQL
    expect(first.format).toBe('parquet')

    expect(second.tableId).toBe('t2')
    expect(registry.size).toBe(2)
  })

  it('never collides after a remove (failed-open rollback) — the counter keeps counting', () => {
    const registry = new TableRegistry()
    const first = registry.reserve('parquet')
    registry.remove(first.tableId)
    const second = registry.reserve('parquet')
    expect(second.tableId).not.toBe(first.tableId)
    expect(registry.size).toBe(1)
  })

  it('resolves handles sent from the main thread; misses are null (not a crash)', () => {
    const registry = new TableRegistry()
    expect(registry.get('t1')).toBeNull()
    const entry = registry.reserve('jsonl')
    expect(registry.get(entry.tableId)).toBe(entry)
    expect(registry.get('bogus')).toBeNull()
  })

  it('clear() returns everything held (dispose cleanup) and empties the registry', () => {
    const registry = new TableRegistry()
    const first = registry.reserve('parquet')
    const second = registry.reserve('json')
    const cleared = registry.clear()

    expect(cleared).toEqual([first, second])
    expect(registry.size).toBe(0)
    expect(registry.get(first.tableId)).toBeNull()
    // Disposal is not a counter reset: post-dispose opens cannot alias stale handles.
    expect(registry.reserve('csv').tableId).toBe('t3')
  })

  it('list() is in creation order and does not leak the internal map', () => {
    const registry = new TableRegistry()
    registry.reserve('parquet')
    registry.reserve('csv')
    const list = [...registry.list()]
    expect(list.map((entry) => entry.tableId)).toEqual(['t1', 't2'])
    list.pop()
    expect(registry.size).toBe(2)
  })

  it('view names are namespaced table ids', () => {
    expect(viewNameForTableId('t42')).toBe('assay_t42')
  })
})
