import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react'
import type { KeyboardEvent } from 'react'
import type { GridViewportModel } from '@assay/grid'
import { RunGuard } from '../sql/run-guard'
import { recordContextShifted, reduceRecordInspector } from './record-state'
import type { RecordContext } from './record-state'
import { buildRecordTree, collectBranchPaths } from './record-tree'
import type { RecordTreeNode } from './record-tree'

/**
 * Record inspector (m3-3): the full-value home for one grid row — the whole
 * record as a disclosure tree, at every depth (the grid cell deliberately
 * shows only a capped preview, m3-2).
 *
 * Design decisions:
 *
 * - **Disclosure pattern, m1-6 precedent.** The tree renders exactly like the
 *   schema panel's type tree: nested lists, native `<button>` toggles with
 *   `aria-expanded`/`aria-controls` (Enter/Space work with zero custom key
 *   handling), dotted-indent children. No `role="tree"` — the repo's pinned
 *   a11y pattern is the disclosure pattern, and mixed idioms would be worse
 *   for screen-reader users than one consistent one. Text nodes only: values
 *   are untrusted content and render as React text, never markup (ADR 0007
 *   spirit; no `dangerouslySetInnerHTML` anywhere in the file).
 * - **Thin component over pure modules.** The tree model (`record-tree.ts`)
 *   and the lifecycle/freshness policy (`record-state.ts`) are Node-tested;
 *   this file only reads the grid model, dispatches events, and renders.
 * - **Freshness (the pinned policy, see `record-state.ts`): an epoch shift
 *   closes the inspector.** The grid's row identity is positional in v1, so
 *   after an accepted sort/filter the same index may hold a different record;
 *   the panel closes instead of silently swapping or stale-rendering. The
 *   mechanism mirrors ProfilePanel's guarded delivery (m2-6): the operative
 *   protection is the state machine's `epoch-shifted` transition driven by
 *   the `recordContextShifted` predicate over the model's live query state;
 *   the `RunGuard` token (imported from the SQL pane, not forked) plus the
 *   `isActive` gate below are the explicit defensive layer that keeps the
 *   render path generation-checked.
 * - **Open gesture.** Rows are focusable and open the inspector on Enter or
 *   click (see `DataGrid`); only `ready` rows open (the model has no record
 *   to show otherwise — the grid shows `…`/`!` placeholders there). Each
 *   open reads the row synchronously from the model cache and rebuilds the
 *   tree, so re-opening/switching rows always shows the current record.
 * - **Focus is not stolen on open** — grid keyboard navigation continues
 *   where it was; the Close button is a plain focusable button (Enter/Space),
 *   and Escape closes when focus is inside the panel.
 * - **Placement.** Rendered by App as a section directly under the grid it
 *   inspects (see App.tsx) — the app composes single-column disclosure
 *   panels; a side layout would introduce a new layout concept.
 */

/** App-held open gesture: which row to inspect; `seq` makes every gesture distinct. */
export interface RecordRequest {
  readonly rowIndex: number
  readonly seq: number
}

interface RecordInspectorProps {
  readonly model: GridViewportModel
  /** Latest open gesture (null = nothing requested / cleared after close). */
  readonly request: RecordRequest | null
  /** Called on every close (user, Escape, or epoch shift) to clear the gesture. */
  readonly onClosed: () => void
}

/** Expansion state: a set of node paths (`deep/a/b`); collapsed by default. */
type ExpandedPaths = ReadonlySet<string>

/** DOM-id-safe form of a node path (keys can contain any characters). */
function nodePathId(path: string): string {
  return `record-node-${path.replaceAll(/[^A-Za-z0-9_-]/g, '-')}`
}

interface NodeViewProps {
  readonly node: RecordTreeNode
  /** Path from the inspected row's root, used as expansion key and DOM id seed. */
  readonly path: string
  readonly expanded: ExpandedPaths
  readonly onToggle: (path: string) => void
}

/** One branch node: toggle button + bounded summary + (when open) children. */
function BranchNode({ node, path, expanded, onToggle }: NodeViewProps) {
  const open = expanded.has(path)
  const detailId = nodePathId(path)
  return (
    <span className="record-branch" data-testid="record-branch">
      <button
        type="button"
        className="record-node-toggle"
        data-testid="record-node-toggle"
        aria-expanded={open}
        aria-controls={detailId}
        onClick={() => {
          onToggle(path)
        }}
      >
        <span className="schema-struct-marker" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span className="record-key" data-testid="record-node-key">
          {node.key}
        </span>
        <span
          className="record-badge"
          data-testid="record-node-badge"
          title={`${node.kind} with ${String(node.children.length)} member${node.children.length === 1 ? '' : 's'}`}
        >
          {node.kind}
        </span>
      </button>
      {/* The bounded preview stays visible next to the expandable structure —
          the same honest one-liner the grid cell showed (m3-2 continuity). */}
      <span className="record-summary" data-testid="record-node-summary">
        {node.summary}
      </span>
      {open && (
        <ul id={detailId} className="record-children" data-testid="record-children">
          {node.children.map((child, index) => (
            <li
              key={index}
              className="record-child"
              data-testid="record-node"
              data-node-kind={child.kind}
              data-node-key={child.key}
            >
              <NodeView
                node={child}
                path={`${path}/${child.key}`}
                expanded={expanded}
                onToggle={onToggle}
              />
            </li>
          ))}
        </ul>
      )}
    </span>
  )
}

/** One leaf/null node: key + the honest full value as text (nulls included). */
function TerminalNode({ node }: { node: RecordTreeNode }) {
  return (
    <span className="record-leaf" data-testid="record-leaf">
      <span className="record-key" data-testid="record-node-key">
        {node.key}
      </span>
      <span
        className={node.kind === 'null' ? 'record-value record-value-null' : 'record-value'}
        data-testid="record-node-value"
      >
        {node.summary}
      </span>
    </span>
  )
}

function NodeView(props: NodeViewProps) {
  const { node } = props
  if (node.kind === 'object' || node.kind === 'array') return <BranchNode {...props} />
  return <TerminalNode node={node} />
}

/** Live snapshot of the grid query state a record's freshness is judged against. */
function readRecordContext(model: GridViewportModel): RecordContext {
  const sort = model.sort
  return {
    sort: sort === null ? null : { column: sort.column, direction: sort.direction },
    filters: model.filters.map((filter) => ({
      column: filter.column,
      predicate: filter.predicate,
    })),
    totalRows: model.totalRows ?? 0,
  }
}

/**
 * Disclosure panel for one row's full record. Renders nothing while closed
 * (or while the open record is stale pending its close transition) — the
 * panel exists only when an honest record is on display.
 */
export function RecordInspector({ model, request, onClosed }: RecordInspectorProps) {
  // The model's version drives freshness re-evaluation: every sort/filter
  // accept and every epoch refetch notifies subscribers.
  useSyncExternalStore(model.subscribe, model.getVersion)
  const [state, dispatch] = useReducer(reduceRecordInspector, { kind: 'closed' as const })
  const guard = useRef(new RunGuard())
  const [expanded, setExpanded] = useState<ExpandedPaths>(() => new Set<string>())
  const onClosedRef = useRef(onClosed)
  useEffect(() => {
    onClosedRef.current = onClosed
  }, [onClosed])

  const close = useCallback(() => {
    guard.current.invalidate()
    dispatch({ type: 'closed' })
    onClosedRef.current()
  }, [])

  const toggle = useCallback((path: string) => {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }, [])

  // Open: a new gesture reads the row synchronously from the model cache.
  // This effect is the readiness guard's home (m4-0 comment fix): the grid
  // emits open gestures for ANY rendered row, and HERE non-ready rows
  // (loading/error/out-of-range) deliberately do not open — there is no
  // record to show honestly; the grid marks them `…`/`!`.
  useEffect(() => {
    if (request === null) return
    const slot = model.getRow(request.rowIndex)
    if (slot.status !== 'ready') return
    const schema = model.schema
    if (schema === null) return
    const token = guard.current.begin()
    setExpanded(new Set<string>()) // every open starts collapsed — a fresh look
    dispatch({
      type: 'opened',
      rowIndex: request.rowIndex,
      token,
      tree: buildRecordTree({
        columns: schema.map((column) => column.name),
        cells: slot.row,
      }),
      context: readRecordContext(model),
    })
  }, [model, request])

  // Freshness (pinned policy): a shifted query state closes the panel. The
  // stale record never paints: the render gate below drops it the moment the
  // shift is observable, and this effect completes the transition + clears
  // the App gesture.
  const stale =
    state.kind === 'open' && recordContextShifted(state.context, readRecordContext(model))
  useEffect(() => {
    if (!stale) return
    guard.current.invalidate()
    dispatch({ type: 'epoch-shifted' })
    onClosedRef.current()
  }, [stale])

  if (state.kind !== 'open' || stale || !guard.current.isActive(state.token)) return null

  const expandAll = (): void => {
    setExpanded(new Set<string>(collectBranchPaths(state.tree)))
  }
  const collapseAll = (): void => {
    setExpanded(new Set<string>())
  }
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape') close()
  }

  return (
    <section
      className="record"
      data-testid="record-inspector"
      data-row-index={state.rowIndex}
      role="region"
      aria-label={`Record inspector — row ${String(state.rowIndex)}`}
      onKeyDown={onKeyDown}
    >
      <header className="record-header">
        <span className="record-title" data-testid="record-title">
          row <span data-testid="record-title-row">{state.rowIndex}</span> — full record
        </span>
        <button
          type="button"
          className="record-affordance"
          data-testid="record-expand-all"
          onClick={expandAll}
        >
          Expand all
        </button>
        <button
          type="button"
          className="record-affordance"
          data-testid="record-collapse-all"
          onClick={collapseAll}
        >
          Collapse all
        </button>
        <button
          type="button"
          className="record-affordance"
          data-testid="record-close"
          onClick={close}
        >
          Close
        </button>
      </header>
      <div className="record-panel" data-testid="record-panel">
        <ul className="record-root" data-testid="record-root">
          {state.tree.children.map((child, index) => (
            <li
              key={index}
              className="record-child"
              data-testid="record-node"
              data-node-kind={child.kind}
              data-node-key={child.key}
            >
              <NodeView node={child} path={child.key} expanded={expanded} onToggle={toggle} />
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
