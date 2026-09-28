// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react'
import type { KeyboardEvent } from 'react'
import type { GridViewportModel } from '@assay/grid'
import { domId, encodePath } from '../lib/dom-id'
import { RunGuard } from '../sql/run-guard'
import {
  recordContextNeedsReload,
  recordContextShifted,
  reduceRecordInspector,
} from './record-state'
import type { RecordContext } from './record-state'
import {
  buildRecordTree,
  collectBranchPaths,
  RECORD_TREE_EXPANDED_MAX_CHILDREN,
  RECORD_TREE_EXPANDED_MAX_DEPTH,
  treeHasTruncation,
} from './record-tree'
import type { RecordTreeBuildOptions, RecordTreeNode } from './record-tree'

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
 * - **Freshness (the pinned policy, see `record-state.ts`).** m3-3: an epoch
 *   shift (accepted sort/filter, or a row-count change) closes the inspector —
 *   positional identity means the same index may hold a different record, and
 *   a stale snapshot must never render as current. m4-3 extends the rule for
 *   the editing era: an effective-schema change (rename/cast) closes too; an
 *   **overlay value change** (a cell edit / undo / redo with the same query
 *   state and schema) instead **re-reads the same logical row** from the
 *   fresh grid epoch — while the refetch is in flight the panel renders an
 *   explicit stale-pending state, so the old values are never painted as
 *   current. The mechanism mirrors ProfilePanel's guarded delivery (m2-6):
 *   the state machine's `epoch-shifted` transition is driven by the
 *   `recordContextShifted` predicate over the model's live state, and the
 *   `RunGuard` token (imported from the SQL pane, not forked) plus the
 *   `isActive` gate below keep the render path generation-checked.
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
  /**
   * m4-3: monotonic overlay revision from the composition root. A change with
   * an unchanged query state/schema means the open record's *values* moved
   * (cell edit / undo / redo): the inspector re-reads the same logical row
   * from the fresh grid epoch instead of rendering a stale snapshot.
   */
  readonly overlayRevision: number
}

/** Expansion state: a set of node paths (`deep/a/b`); collapsed by default. */
type ExpandedPaths = ReadonlySet<string>

/**
 * DOM-id-safe, injective form of a node path (record keys can contain any
 * characters; AR-W11 grammar via `lib/dom-id.ts` — the old lossy
 * `[^A-Za-z0-9_-] → -` filter made `a.b` and `a-b` collide).
 */
function nodePathId(path: string): string {
  return domId('record-node', path)
}

interface NodeViewProps {
  readonly node: RecordTreeNode
  /**
   * Field-key segments from the inspected row's root. The expansion key is
   * `encodePath(segments)`: each segment is encoded so a key containing `/`
   * cannot be confused with nesting (`x/y` vs child `y` of `x`).
   */
  readonly segments: readonly string[]
  readonly expanded: ExpandedPaths
  readonly onToggle: (path: string) => void
}

/** One branch node: toggle button + bounded summary + (when open) children. */
function BranchNode({ node, segments, expanded, onToggle }: NodeViewProps) {
  const path = encodePath(segments)
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
      {/* AR-W8: honest truncation notes stay visible even while collapsed. */}
      {node.omittedChildren !== undefined && node.omittedChildren > 0 && (
        <span className="record-truncated" data-testid="record-truncated" role="note">
          … {String(node.omittedChildren)} more not shown
        </span>
      )}
      {node.depthCapped === true && (
        <span className="record-depth-capped" data-testid="record-depth-capped" role="note">
          … deeper values not shown
        </span>
      )}
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
                segments={[...segments, child.key]}
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

/**
 * Live snapshot of the grid state a record's freshness is judged against
 * (m4-3 shape). `schemaSignature` is a stable serialization of the effective
 * schema (name + type per column, in order); `rowKey` is the logical row id
 * the snapshot was read from, when the provider supplies one.
 */
function readRecordContext(
  model: GridViewportModel,
  overlayRevision: number,
  rowIndex: number,
): RecordContext {
  const sort = model.sort
  const slot = model.getRow(rowIndex)
  return {
    sort: sort === null ? null : { column: sort.column, direction: sort.direction },
    filters: model.filters.map((filter) => ({
      column: filter.column,
      predicate: filter.predicate,
    })),
    totalRows: model.totalRows ?? 0,
    overlayRevision,
    schemaSignature: (model.schema ?? [])
      .map((column) => `${column.name}\t${column.type}`)
      .join('\n'),
    rowKey: slot.status === 'ready' ? (slot.key ?? null) : null,
  }
}

/**
 * Disclosure panel for one row's full record. Renders nothing while closed
 * (or while the open record is stale pending its close transition) — the
 * panel exists only when an honest record is on display.
 */
export function RecordInspector({
  model,
  request,
  onClosed,
  overlayRevision,
}: RecordInspectorProps) {
  // The model's version drives freshness re-evaluation: every sort/filter
  // accept and every epoch refetch notifies subscribers.
  const modelVersion = useSyncExternalStore(model.subscribe, model.getVersion)
  const [state, dispatch] = useReducer(reduceRecordInspector, { kind: 'closed' as const })
  const guard = useRef(new RunGuard())
  /**
   * The element focused when the inspector opened (the grid row / jump
   * control that triggered the gesture). `close()` returns focus there so
   * Escape/Close never strands focus on `<body>` once the panel unmounts —
   * the ExportDialog focus-restore pattern (capture the opener, restore on
   * close when it is still connected).
   */
  const openerRef = useRef<HTMLElement | null>(null)
  const [expanded, setExpanded] = useState<ExpandedPaths>(() => new Set<string>())
  /**
   * AR-W8: the tree is capped (length + depth) so a large list cell cannot
   * freeze the main thread. This flips the caps to the expanded bound when
   * the user asks to see the full value; the ref lets the freshness reload
   * path read the current choice without re-running the open effect.
   */
  const [fullValues, setFullValues] = useState(false)
  const fullValuesRef = useRef(false)
  fullValuesRef.current = fullValues
  /**
   * f-3: latest overlay revision, read by the open effect without becoming a
   * dependency. A new edit must not re-run the open effect (that would reset
   * the user's expansion state); it reloads the same snapshot through the
   * reload effect below. But when a *new* open gesture arrives the snapshot's
   * freshness baseline must be the current revision, so the effect reads the
   * ref instead of a stale closure. Latest-value-ref (same shape as
   * `fullValuesRef` above) — the cache invalidation stays correct and the
   * dependency array holds no ignored variable.
   */
  const overlayRevisionRef = useRef(overlayRevision)
  // Latest-value ref — assign every render (the `fullValuesRef` shape). This
  // line is load-bearing: without it the ref freezes at the mount-time
  // revision and every post-edit open gesture snapshots a stale baseline,
  // triggering a spurious freshness reload (caught in f-3 review; pinned by
  // the open-after-edit build-count test).
  overlayRevisionRef.current = overlayRevision
  const onClosedRef = useRef(onClosed)
  useEffect(() => {
    onClosedRef.current = onClosed
  }, [onClosed])

  const close = useCallback(() => {
    guard.current.invalidate()
    dispatch({ type: 'closed' })
    const opener = openerRef.current
    openerRef.current = null
    // The focused Close button is about to unmount; hand focus back to the
    // element that opened the inspector when it is still in the document.
    if (opener !== null && opener.isConnected) opener.focus()
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
    openerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    setExpanded(new Set<string>()) // every open starts collapsed — a fresh look
    // AR-W8: every open starts capped; the user can expand on request.
    fullValuesRef.current = false
    setFullValues(false)
    const options: RecordTreeBuildOptions = {}
    dispatch({
      type: 'opened',
      rowIndex: request.rowIndex,
      token,
      tree: buildRecordTree(
        {
          columns: schema.map((column) => column.name),
          cells: slot.row,
        },
        options,
      ),
      context: readRecordContext(model, overlayRevisionRef.current, request.rowIndex),
    })
    // Deliberately NOT keyed on `overlayRevision`: a new edit must reload the
    // open snapshot (the reload effect below), not re-open and reset the
    // user's expansion state. The ref above carries the latest value into
    // this effect when a new gesture arrives.
  }, [model, request])

  const currentContext =
    state.kind === 'open' ? readRecordContext(model, overlayRevision, state.rowIndex) : null
  // Structural/query shift → close (pinned m3-3 rule, extended m4-3 with the
  // schema signature). Value-only overlay shift → reload the same row.
  const shifted =
    state.kind === 'open' &&
    currentContext !== null &&
    recordContextShifted(state.context, currentContext)
  const needsReload =
    state.kind === 'open' &&
    currentContext !== null &&
    recordContextNeedsReload(state.context, currentContext)

  useEffect(() => {
    if (!shifted) return
    guard.current.invalidate()
    dispatch({ type: 'epoch-shifted' })
    onClosedRef.current()
  }, [shifted])

  // Reload path (m4-3): read the same logical row from the fresh epoch. The
  // effect runs on model notifications too, so it naturally waits for the
  // refetch to land. Until then the render below shows a stale-pending state
  // — the old snapshot is never painted as current.
  useEffect(() => {
    if (!needsReload || state.kind !== 'open') return
    const slot = model.getRow(state.rowIndex)
    if (slot.status === 'loading') return // wait for the refetch to land
    if (slot.status === 'error') {
      guard.current.invalidate()
      dispatch({ type: 'epoch-shifted' })
      onClosedRef.current()
      return
    }
    // The position must still hold the same logical row (defence in depth for
    // a same-count delete+insert displacement): a different key closes rather
    // than silently swapping the record under the title.
    if (
      state.context.rowKey !== null &&
      slot.key !== undefined &&
      slot.key !== state.context.rowKey
    ) {
      guard.current.invalidate()
      dispatch({ type: 'epoch-shifted' })
      onClosedRef.current()
      return
    }
    const schema = model.schema
    if (schema === null) return
    // AR-W8: preserve the user's expanded-caps choice across a value reload.
    const options: RecordTreeBuildOptions = fullValuesRef.current
      ? {
          maxChildren: RECORD_TREE_EXPANDED_MAX_CHILDREN,
          maxDepth: RECORD_TREE_EXPANDED_MAX_DEPTH,
        }
      : {}
    dispatch({
      type: 'reloaded',
      tree: buildRecordTree(
        {
          columns: schema.map((column) => column.name),
          cells: slot.row,
        },
        options,
      ),
      context: readRecordContext(model, overlayRevision, state.rowIndex),
    })
  }, [needsReload, state, model, overlayRevision, modelVersion])

  if (state.kind !== 'open' || shifted || !guard.current.isActive(state.token)) return null

  if (needsReload) {
    // Stale-until-reloaded: an explicit pending state, never the old values.
    return (
      <section
        className="record record-stale"
        data-testid="record-inspector"
        data-stale="true"
        data-row-index={state.rowIndex}
        role="status"
        aria-label={`Reloading record — row ${String(state.rowIndex)}`}
      >
        <p data-testid="record-reloading">Reloading record…</p>
      </section>
    )
  }

  const expandAll = (): void => {
    setExpanded(new Set<string>(collectBranchPaths(state.tree)))
  }
  const collapseAll = (): void => {
    setExpanded(new Set<string>())
  }
  /** AR-W8: rebuild the open record's tree with the expanded caps. */
  const showAllValues = (): void => {
    if (state.kind !== 'open') return
    const slot = model.getRow(state.rowIndex)
    if (slot.status !== 'ready') return
    const schema = model.schema
    if (schema === null) return
    fullValuesRef.current = true
    setFullValues(true)
    dispatch({
      type: 'reloaded',
      tree: buildRecordTree(
        { columns: schema.map((column) => column.name), cells: slot.row },
        {
          maxChildren: RECORD_TREE_EXPANDED_MAX_CHILDREN,
          maxDepth: RECORD_TREE_EXPANDED_MAX_DEPTH,
        },
      ),
      context: readRecordContext(model, overlayRevision, state.rowIndex),
    })
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
      <h2 className="visually-hidden">Record</h2>
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
        {!fullValues && treeHasTruncation(state.tree) && (
          <button
            type="button"
            className="record-affordance"
            data-testid="record-show-all-values"
            onClick={showAllValues}
          >
            Show all values
          </button>
        )}
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
              <NodeView node={child} segments={[child.key]} expanded={expanded} onToggle={toggle} />
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
