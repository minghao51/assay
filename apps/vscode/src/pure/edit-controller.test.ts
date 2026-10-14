// SPDX-License-Identifier: AGPL-3.0-or-later

import { baseRowId, effectiveRowIds, overlayEdit } from '@assay/domain'
import type { OverlayBase, TransformationHistory } from '@assay/domain'
import { describe, expect, it, vi } from 'vitest'
import { EditController } from './edit-controller'

const base: OverlayBase = {
  baseAnchor: 'immutable-version',
  overlayAnchor: 'session-one',
  columns: [
    { name: 'id', type: 'BIGINT' },
    { name: 'label', type: 'VARCHAR' },
  ],
  baseRowCount: 3,
}
const first = baseRowId(base.baseAnchor, 0)

function harness(
  preflight: (history: TransformationHistory) => Promise<void> = async () => undefined,
) {
  const seen: TransformationHistory[] = []
  const controller = new EditController(base, {
    preflight,
    activate: async (history) => {
      seen.push(history)
    },
  })
  return { controller, seen }
}

describe('EditController', () => {
  it('uses domain history and branches after undo; inserted ids are session logical ids', async () => {
    const { controller, seen } = harness()
    await controller.commitCell(first, 'label', { kind: 'string', value: 'changed' })
    await controller.insertRow()
    await controller.undo()
    await controller.commitCell(first, 'id', { kind: 'text', text: '9007199254740993' })
    expect(controller.snapshot.history.cursor).toBe(2)
    expect(controller.snapshot.history.entries).toHaveLength(2)
    expect(controller.snapshot.history.entries.map(({ op }) => op.kind)).toEqual([
      'cell-set',
      'cell-set',
    ])
    expect(seen).toHaveLength(4)
  })

  it('does not advance history or publish a rejected candidate', async () => {
    const activation = vi.fn(async () => undefined)
    const controller = new EditController(base, {
      preflight: async () => {
        throw new Error('cast rejected\nprivate SQL details')
      },
      activate: activation,
    })
    await controller.commitCell(first, 'id', { kind: 'text', text: 'invalid' })
    expect(controller.snapshot.history.entries).toHaveLength(0)
    expect(activation).not.toHaveBeenCalled()
    expect(controller.snapshot.error).toContain('cast rejected')
    expect(controller.snapshot.error).not.toContain('private SQL details')
  })

  it('records an honest no-op outcome without inventing a value change', async () => {
    const { controller } = harness()
    const value = { kind: 'string' as const, value: 'same' }
    await controller.commitCell(first, 'label', value)
    await controller.commitCell(first, 'label', value)
    expect(controller.snapshot.history.entries).toHaveLength(2)
    expect(controller.snapshot.history.entries[1]?.outcome).toEqual({
      status: 'no-op',
      reason: 'cell-value-unchanged',
    })
    expect(controller.snapshot.error).toContain('No change')
  })

  it('rolls back a rejected activation before committing the candidate history', async () => {
    const activated: TransformationHistory[] = []
    const controller = new EditController(base, {
      preflight: async () => undefined,
      activate: async (history) => {
        activated.push(history)
        if (history.cursor > 0) throw new Error('effective view rejected')
      },
    })
    await controller.commitCell(first, 'label', { kind: 'string', value: 'candidate' })
    expect(activated).toHaveLength(2)
    expect(activated[0]?.cursor).toBe(1)
    expect(activated[1]?.cursor).toBe(0)
    expect(controller.snapshot.history.entries).toHaveLength(0)
    expect(controller.snapshot.error).toContain('effective view rejected')
  })

  it('serializes overlapping commits so accepted operations do not clobber each other', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let probes = 0
    const { controller } = harness(async () => {
      probes++
      if (probes === 1) await gate
    })
    const one = controller.commitCell(first, 'label', { kind: 'string', value: 'one' })
    const two = controller.commitCell(first, 'id', { kind: 'text', text: '2' })
    await Promise.resolve()
    expect(controller.snapshot.history.entries).toHaveLength(0)
    release?.()
    await Promise.all([one, two])
    expect(controller.snapshot.history.entries).toHaveLength(2)
    expect(probes).toBe(2)
  })

  it('allocates unique insert ids for rapidly overlapping insert requests', async () => {
    const { controller } = harness()
    const firstInsert = controller.insertRow()
    const secondInsert = controller.insertRow()
    await Promise.all([firstInsert, secondInsert])
    const state = (await import('@assay/domain')).stateAtCursor(base, controller.currentHistory)
    expect([...state.inserts.keys()]).toEqual(['ins:session-one#0', 'ins:session-one#1'])
  })

  it('resolves rapid undo and redo steps against queued current history', async () => {
    const { controller } = harness()
    await controller.commitCell(first, 'label', { kind: 'string', value: 'one' })
    await controller.commitCell(first, 'id', { kind: 'text', text: '2' })
    await Promise.all([controller.undo(), controller.undo()])
    expect(controller.snapshot.history.cursor).toBe(0)
    await Promise.all([controller.redo(), controller.redo()])
    expect(controller.snapshot.history.cursor).toBe(2)
  })

  it('orders a queued commit before undo and fences midflight disposal', async () => {
    const { controller } = harness()
    await Promise.all([
      controller.commitCell(first, 'label', { kind: 'string', value: 'one' }),
      controller.undo(),
    ])
    expect(controller.snapshot.history.cursor).toBe(0)

    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const delayed = new EditController(base, {
      preflight: async () => {
        await gate
      },
      activate: async () => undefined,
    })
    const operation = delayed.commitCell(first, 'label', { kind: 'string', value: 'late' })
    await Promise.resolve()
    delayed.dispose()
    release?.()
    await operation
    expect(delayed.snapshot.history.entries).toHaveLength(0)
  })

  it('fences queued work after disposal', async () => {
    const { controller } = harness()
    controller.dispose()
    await controller.commitCell(first, 'label', { kind: 'string', value: 'ignored' })
    expect(controller.snapshot.history.entries).toHaveLength(0)
  })

  it('maintains domain overlay identity and reports outcomes without storing failed edits', async () => {
    const { controller } = harness()
    await controller.insertRow()
    const history = controller.snapshot.history
    const state = (await import('@assay/domain')).stateAtCursor(base, history)
    expect(effectiveRowIds(base, state)).toHaveLength(4)
    expect([...state.inserts.keys()][0]).toBe('ins:session-one#0')
    await controller.commitCell(first, 'missing-column', { kind: 'null' })
    expect(controller.snapshot.history).toBe(history)
    expect(controller.snapshot.error).toMatch(/unknown-column/)
    expect(overlayEdit(state, first, 'label')).toBeNull()
  })
})
