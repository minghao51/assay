import { describe, expect, it } from 'vitest'
import { buildRecordTree } from './record-tree'
import type { RecordTreeNode } from './record-tree'
import {
  recordContextNeedsReload,
  recordContextShifted,
  reduceRecordInspector,
} from './record-state'
import type { RecordContext, RecordInspectorEvent, RecordInspectorState } from './record-state'

/**
 * m3-3/m4-3 unit tests for the inspector lifecycle + freshness policy. The
 * policy under test (pinned in `record-state.ts`): a query/schema epoch shift
 * CLOSES the open record — never re-resolves the position, never keeps a
 * stale snapshot; an overlay value-only change RELOADS the same logical row
 * (never paints the old snapshot as current while the refetch is pending).
 */

function context(overrides: Partial<RecordContext> = {}): RecordContext {
  return {
    sort: null,
    filters: [],
    totalRows: 12,
    overlayRevision: 0,
    schemaSignature: 'id\tBIGINT',
    rowKey: 'base:anchor#0',
    ...overrides,
  }
}

const TREE: RecordTreeNode = buildRecordTree({ columns: ['id'], cells: [1n] })

function openEvent(
  overrides: {
    rowIndex?: number
    token?: number
    tree?: RecordTreeNode
    context?: RecordContext
  } = {},
): Extract<RecordInspectorEvent, { type: 'opened' }> {
  return {
    type: 'opened',
    rowIndex: overrides.rowIndex ?? 0,
    token: overrides.token ?? 1,
    tree: overrides.tree ?? TREE,
    context: overrides.context ?? context(),
  }
}

function expectOpen(state: RecordInspectorState): Extract<RecordInspectorState, { kind: 'open' }> {
  if (state.kind !== 'open') throw new Error(`expected open, got ${state.kind}`)
  return state
}

describe('reduceRecordInspector', () => {
  it('opens: the state carries the row index, guard token, tree, and open context', () => {
    const state = reduceRecordInspector({ kind: 'closed' }, openEvent({ rowIndex: 3, token: 7 }))
    const open = expectOpen(state)
    expect(open.rowIndex).toBe(3)
    expect(open.token).toBe(7)
    expect(open.tree).toBe(TREE)
    expect(open.context).toEqual(context())
  })

  it('switching rows replaces the whole open record (new row, new token, fresh tree)', () => {
    const first = reduceRecordInspector({ kind: 'closed' }, openEvent({ rowIndex: 0, token: 1 }))
    const second = reduceRecordInspector(
      first,
      openEvent({ rowIndex: 2, token: 2, tree: buildRecordTree({ columns: ['id'], cells: [3n] }) }),
    )
    const open = expectOpen(second)
    expect(open.rowIndex).toBe(2)
    expect(open.token).toBe(2)
    expect(open.tree.children[0]?.summary).toBe('3')
  })

  it('user close → closed', () => {
    const state = reduceRecordInspector(reduceRecordInspector({ kind: 'closed' }, openEvent()), {
      type: 'closed',
    })
    expect(state).toEqual({ kind: 'closed' })
  })

  it('epoch shift → closed: the stale record never survives as if current (pinned policy)', () => {
    const state = reduceRecordInspector(reduceRecordInspector({ kind: 'closed' }, openEvent()), {
      type: 'epoch-shifted',
    })
    expect(state).toEqual({ kind: 'closed' })
  })

  it('an epoch shift on a closed inspector stays closed (inert, not an error)', () => {
    expect(reduceRecordInspector({ kind: 'closed' }, { type: 'epoch-shifted' })).toEqual({
      kind: 'closed',
    })
  })
})

describe('recordContextShifted — the freshness predicate', () => {
  it('is false when nothing changed (even with fresh array/object identities)', () => {
    const opened = context({
      sort: { column: 'id', direction: 'asc' },
      filters: [
        { column: 'kind', predicate: "= 'alpha'" },
        { column: 'score', predicate: '> 5' },
      ],
    })
    const current = context({
      sort: { column: 'id', direction: 'asc' },
      filters: [
        { column: 'kind', predicate: "= 'alpha'" },
        { column: 'score', predicate: '> 5' },
      ],
    })
    expect(recordContextShifted(opened, current)).toBe(false)
  })

  it('is true when the sort appears, disappears, flips direction, or changes column', () => {
    const opened = context({ sort: { column: 'id', direction: 'asc' } })
    expect(
      recordContextShifted(opened, context({ sort: { column: 'id', direction: 'desc' } })),
    ).toBe(true)
    expect(
      recordContextShifted(opened, context({ sort: { column: 'kind', direction: 'asc' } })),
    ).toBe(true)
    expect(recordContextShifted(opened, context())).toBe(true)
    expect(
      recordContextShifted(context(), context({ sort: { column: 'id', direction: 'asc' } })),
    ).toBe(true)
  })

  it('is true when filters appear, disappear, reorder, or change predicate text', () => {
    const filters = [{ column: 'kind', predicate: "= 'alpha'" }]
    expect(recordContextShifted(context(), context({ filters }))).toBe(true)
    expect(recordContextShifted(context({ filters }), context())).toBe(true)
    const changed = [{ column: 'kind', predicate: "= 'beta'" }]
    expect(recordContextShifted(context({ filters }), context({ filters: changed }))).toBe(true)
    // AND-composition is order-sensitive: a reordered list is a different query.
    const reordered = [
      { column: 'score', predicate: '> 5' },
      { column: 'kind', predicate: "= 'alpha'" },
    ]
    const both = [
      { column: 'kind', predicate: "= 'alpha'" },
      { column: 'score', predicate: '> 5' },
    ]
    expect(recordContextShifted(context({ filters: both }), context({ filters: reordered }))).toBe(
      true,
    )
  })

  it('is true when the total row count changed under the same query state', () => {
    expect(recordContextShifted(context(), context({ totalRows: 11 }))).toBe(true)
  })

  it('is true when the effective schema signature changed (rename/cast, m4-3)', () => {
    expect(
      recordContextShifted(context(), context({ schemaSignature: 'id\tBIGINT\nname\tVARCHAR' })),
    ).toBe(true)
  })

  it('ignores overlay-revision-only changes (that is a reload, not a shift)', () => {
    expect(recordContextShifted(context(), context({ overlayRevision: 3 }))).toBe(false)
  })
})

describe('recordContextNeedsReload — the value-only freshness predicate (m4-3)', () => {
  it('is true for an overlay-revision change with the same query state and schema', () => {
    expect(recordContextNeedsReload(context(), context({ overlayRevision: 2 }))).toBe(true)
  })

  it('is false when nothing changed', () => {
    expect(recordContextNeedsReload(context(), context())).toBe(false)
  })

  it('is false when the change is a structural shift (close wins over reload)', () => {
    expect(
      recordContextNeedsReload(
        context(),
        context({ overlayRevision: 2, schemaSignature: 'id\tVARCHAR' }),
      ),
    ).toBe(false)
    expect(
      recordContextNeedsReload(context(), context({ overlayRevision: 2, totalRows: 99 })),
    ).toBe(false)
  })
})

describe('reduceRecordInspector — reloaded event (m4-3)', () => {
  it('advances the snapshot and context without changing row/token/expansion surface', () => {
    const opened = reduceRecordInspector({ kind: 'closed' }, openEvent({ rowIndex: 3, token: 7 }))
    const tree = buildRecordTree({ columns: ['id'], cells: [9n] })
    const reloaded = reduceRecordInspector(opened, {
      type: 'reloaded',
      tree,
      context: context({ overlayRevision: 1 }),
    })
    const open = expectOpen(reloaded)
    expect(open.rowIndex).toBe(3)
    expect(open.token).toBe(7)
    expect(open.tree).toBe(tree)
    expect(open.context.overlayRevision).toBe(1)
  })

  it('a late reload over a closed state is inert (never resurrects a record)', () => {
    const closed = reduceRecordInspector({ kind: 'closed' }, { type: 'closed' })
    expect(
      reduceRecordInspector(closed, { type: 'reloaded', tree: TREE, context: context() }),
    ).toEqual({ kind: 'closed' })
  })
})
