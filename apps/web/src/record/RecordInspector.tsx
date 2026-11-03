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
 *   tree, so re-opening/switching rows always shows the current record. A
 *   gesture made on a still-`loading` row is not dropped (uxc-2): the
 *   pending gesture resolves when the slot lands — unless a structural epoch
 *   shift intervened or the slot settled `error`, in which case it is dropped
 *   rather than pointed at a different record.
 * - **Focus.** Historical policy (kept for every request that does not opt
 *   in): the panel NEVER steals focus — grid keyboard navigation continues
 *   where it was, the Close button is a plain focusable button (Enter/Space),
 *   and Escape closes when focus is inside the panel. ux-a3 adds ONE opt-in:
 *   an explicit grid row activation (Enter or a row click — the same gesture)
 *   sets `RecordRequest.focusOnOpen`, and a FRESH open of that request lands
 *   focus on the panel container once the requested record is honestly on
 *   display, so the next Escape/Close closes the panel instead of stranding
 *   the user on the grid (the recorded 18-Tab gap). Validation/diff "Show
 *   row" jumps and the dock's Prev/Next step keep their existing focus policy
 *   (no flag) — ug-12's roving grid focus and the dock's own controls are
 *   untouched. A focus request never re-fires for a step, an overlay value
 *   reload, a model notification or an expansion, and it retires (rather
 *   than stealing focus late) when the user deliberately moved focus while a
 *   pending row was still loading.
 * - **Placement.** Rendered by App as a section directly under the grid it
 *   inspects (see App.tsx) — the app composes single-column disclosure
 *   panels; a side layout would introduce a new layout concept.
 */

/** App-held open gesture: which row to inspect; `seq` makes every gesture distinct. */
export interface RecordRequest {
  readonly rowIndex: number
  readonly seq: number
  /**
   * ux-a3: set ONLY by explicit grid row activation (Enter on a focused row or
   * a row click — the same gesture, wired in App's `onOpenRecord`). A fresh
   * open of such a request lands focus on the inspector container once the
   * requested record is honestly rendered. Absent (or false) keeps the
   * historical no-focus-steal policy: panel "Show row" jumps and the dock's
   * Prev/Next step never touch focus.
   */
  readonly focusOnOpen?: boolean
}

interface RecordInspectorProps {
  readonly model: GridViewportModel
  /** Latest open gesture (null = nothing requested / cleared after close). */
  readonly request: RecordRequest | null
  /** Called on every close (user, Escape, or epoch shift) to clear the gesture. */
  readonly onClosed: () => void
  /**
   * ug-11 (UG-12): the dock's ◀ Prev / ▶ Next request. The component decides
   * whether the IMMEDIATE neighbour is steppable (so "disabled" and "where to
   * step" can never disagree) and asks the composition root to open it through
   * the SAME request/scroll machinery every row gesture uses — the dock never
   * invents a second read path and never closes itself to step.
   */
  readonly onStep: (rowIndex: number) => void
  /**
   * m4-3: monotonic overlay revision from the composition root. A change with
   * an unchanged query state/schema means the open record's *values* moved
   * (cell edit / undo / redo): the inspector re-reads the same logical row
   * from the fresh grid epoch instead of rendering a stale snapshot.
   */
  readonly overlayRevision: number
}

/** ug-11: 1-based row number, the ONE convention this dock and the grid's
 * gutter both display. The 0-based effective index stays in `data-row-index`
 * (the jump/scroll contract) and in `request.rowIndex`; only user-facing
 * numbers are shifted, so `row 1` is the first row of the dataset. */
function displayRowNumber(rowIndex: number): number {
  return rowIndex + 1
}

/**
 * ug-11: the IMMEDIATE neighbour in one direction (`from ± 1`), or `null` at
 * the dataset bounds / when that slot settled `error`.
 *
 * Stepping is deliberately O(1): `getRow` is called at most ONCE per direction
 * (and only after a bounds check), so a render or click can never walk the
 * dataset. The viewport model reports every uncached/not-yet-requested index as
 * `loading`, so a "scan to the next ready row" is an unbounded synchronous walk
 * on a large sparse cache — a main-thread freeze in the supported million-row
 * scenario (ug-11 review finding 1). The queue's literal contract is immediate
 * neighbour stepping anyway: Next from row N opens N+1.
 *
 * A `loading` neighbour stays ENABLED: the existing uxc-2 pending-gesture
 * machinery remembers the request and opens the row when its slot lands (the
 * same path a click on a loading grid row uses), so the gesture is never
 * dropped. An `error` neighbour is disabled — the failed span will never yield
 * a record, so the click would be a dead gesture.
 */
function adjacentStepRow(model: GridViewportModel, from: number, direction: -1 | 1): number | null {
  const target = from + direction
  const totalRows = model.totalRows ?? 0
  if (target < 0 || target >= totalRows) return null
  if (model.getRow(target).status === 'error') return null
  return target
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
  onStep,
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
  /**
   * ux-a3: the one-shot focus request for a FRESH explicit row open (see
   * `RecordRequest.focusOnOpen`). Set in the open effect, consumed exactly
   * once by the effect below, and cleared on every gesture that is dropped or
   * superseded so a stale request can never steal focus later.
   */
  const openFocusRef = useRef<{
    readonly deferred: boolean
    readonly opener: HTMLElement | null
  } | null>(null)
  /** The panel container, the non-modal focus target of a fresh explicit open. */
  const sectionRef = useRef<HTMLElement | null>(null)
  /**
   * ux-a3: the focus owner and readiness seen when the CURRENT gesture arrived.
   * A gesture made on a still-loading row resolves later; if the user moved
   * focus elsewhere in the meantime, the record still opens (when valid) but
   * the focus request retires rather than yanking focus away from them.
   */
  const gestureRef = useRef<{
    seq: number
    opener: HTMLElement | null
    deferred: boolean
  } | null>(null)
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
  /**
   * uxc-2: the request `seq` most recently opened OR dropped. `seq` is
   * monotonic per gesture (App), so this both prevents a repeat notification
   * from re-opening (which would churn the guard token and reset the user's
   * expansion state) and records that a pending gesture has been resolved.
   * Reset to null when the request clears, so the next gesture is always
   * handled. `begin()` is only ever taken in the actual open below.
   */
  const handledSeqRef = useRef<number | null>(null)
  /**
   * uxc-2: the structural context captured when a gesture arrives on a
   * still-loading row. If the dataset epoch shifts before the slot lands
   * (accepted sort/filter, count/schema change), the same positional index no
   * longer names the record the user clicked — the gesture is dropped rather
   * than opening a different record (the pinned epoch-shift rule applied
   * before the open).
   */
  const pendingContextRef = useRef<{ seq: number; context: RecordContext } | null>(null)
  /**
   * ug-11: whether a record is already on display. The opener captured below
   * is the element focus returns to on Close; stepping to an adjacent row is
   * the SAME open request re-firing (new `seq`) while the dock stays open, and
   * the focused Prev/Next button is the wrong thing to remember as the
   * opener — it is about to be re-rendered as the panel re-points, and on a
   * later Close the user would land on `<body>`. Capturing only on a fresh
   * open keeps the existing focus-restore behavior (back to the grid row).
   */
  const openRef = useRef(false)
  openRef.current = state.kind === 'open'

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
  //
  // uxc-2 defect + edge policy: the effect is keyed on `modelVersion`, so a
  // gesture made on a still-loading row resolves when the slot lands instead
  // of being silently dropped (before, the guard early-returned and the
  // effect never re-ran because `request` was unchanged). Edges:
  //   - lands `ready`, no structural shift → open (below).
  //   - lands `error` / is out-of-range → no record can ever appear at this
  //     position: drop the gesture through the App's close callback (the
  //     existing machinery for clearing the request) so it never hangs.
  //   - a structural shift while still pending → drop, never open a
  //     different record at the same positional index.
  //   - repeated notifications for an already-open gesture → no-op, so the
  //     guard token and the user's expansion state are not churned.
  useEffect(() => {
    if (request === null) {
      handledSeqRef.current = null
      pendingContextRef.current = null
      gestureRef.current = null
      openFocusRef.current = null
      return
    }
    if (handledSeqRef.current === request.seq) return // already opened or dropped
    const slot = model.getRow(request.rowIndex)
    if (gestureRef.current?.seq !== request.seq) {
      // ux-a3: the focus owner and readiness THIS gesture arrived under. Both
      // are read once per gesture (a later model notification re-runs this
      // effect with the same `seq` and must not re-baseline them).
      gestureRef.current = {
        seq: request.seq,
        opener: document.activeElement instanceof HTMLElement ? document.activeElement : null,
        deferred: slot.status !== 'ready',
      }
    }
    if (slot.status === 'error') {
      // Out-of-range index or a failed span: the gesture can never be
      // satisfied at this position, so drop it explicitly (via the same
      // callback that clears the request on user close) instead of leaving
      // it pending forever. Nothing was opened, so no focus request survives.
      handledSeqRef.current = request.seq
      pendingContextRef.current = null
      openFocusRef.current = null
      onClosedRef.current()
      return
    }
    if (slot.status !== 'ready') {
      // Still loading: remember the structural context the user clicked
      // under and wait for a later notification (this effect re-runs on
      // every modelVersion bump).
      if (pendingContextRef.current?.seq !== request.seq) {
        pendingContextRef.current = {
          seq: request.seq,
          context: readRecordContext(model, overlayRevisionRef.current, request.rowIndex),
        }
      }
      return
    }
    const context = readRecordContext(model, overlayRevisionRef.current, request.rowIndex)
    const pending = pendingContextRef.current
    if (
      pending !== null &&
      pending.seq === request.seq &&
      recordContextShifted(pending.context, context)
    ) {
      // The epoch moved while the gesture waited — sort/filter/count/schema
      // changed, so index N now names a different record. Opening it would
      // present a stale-looking record as the one clicked. Drop it, exactly
      // as the epoch-shift rule closes an already-open panel.
      handledSeqRef.current = request.seq
      pendingContextRef.current = null
      openFocusRef.current = null
      onClosedRef.current()
      return
    }
    const schema = model.schema
    if (schema === null) return
    // The actual open: only now is the guard token taken and the pending
    // bookkeeping cleared (no token churn from repeat notifications).
    handledSeqRef.current = request.seq
    pendingContextRef.current = null
    const token = guard.current.begin()
    if (!openRef.current) {
      openerRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null
      // ux-a3: only a FRESH explicit row activation opts into taking focus; a
      // step (already-open panel) or a request without the flag keeps the
      // historical policy. `deferred` records that the row was still loading
      // when the user asked, so a late landing can bow out if they moved on.
      openFocusRef.current =
        request.focusOnOpen === true
          ? {
              deferred: gestureRef.current?.deferred === true,
              opener: gestureRef.current?.opener ?? null,
            }
          : null
    }
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
      context,
    })
    // Deliberately NOT keyed on `overlayRevision`: a new edit must reload the
    // open snapshot (the reload effect below), not re-open and reset the
    // user's expansion state. The ref above carries the latest value into
    // this effect when a new gesture arrives.
  }, [model, request, modelVersion])

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

  /**
   * ux-a3: land the fresh explicit-open focus request exactly once, after a
   * render that actually shows the requested record (pending gestures resolve
   * here when their slot lands). Deliberately NOT keyed on anything: it runs
   * after every commit, consumes the one-shot request, and is a no-op
   * otherwise — so a step, an overlay reload, a model notification or an
   * expansion can never re-focus the panel. It must also survive the
   * stale-until-reloaded commit: `needsReload` paints the placeholder section,
   * which has no focus target, so consuming the request there would silently
   * no-op and the honestly-rendered record would never be focused.
   */
  useEffect(() => {
    const pending = openFocusRef.current
    if (pending === null) return
    if (state.kind !== 'open' || shifted || needsReload || sectionRef.current === null) return
    openFocusRef.current = null
    if (pending.deferred) {
      const current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      // The row was still loading when the user asked, and they have since
      // moved focus somewhere else on purpose: the record still opens, but the
      // focus request retires instead of pulling focus back.
      if (current !== null && current !== document.body && current !== pending.opener) return
    }
    sectionRef.current?.focus()
  })

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
        aria-label={`Reloading record — row ${String(displayRowNumber(state.rowIndex))}`}
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
  /** ug-11: the immediate-neighbour targets, resolved against the live model. */
  const previousRow = adjacentStepRow(model, state.rowIndex, -1)
  const nextRow = adjacentStepRow(model, state.rowIndex, 1)

  return (
    <section
      ref={sectionRef}
      className="record"
      data-testid="record-inspector"
      data-row-index={state.rowIndex}
      role="region"
      aria-label={`Record inspector — row ${String(displayRowNumber(state.rowIndex))}`}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <h2 className="visually-hidden">Record</h2>
      <header className="record-header">
        <span className="record-title" data-testid="record-title">
          row <span data-testid="record-title-row">{displayRowNumber(state.rowIndex)}</span> — full
          record
        </span>
        {/* ug-11 (UG-12): step through the dataset without leaving the dock.
            Next/Prev target the IMMEDIATE neighbour (N+1 / N-1); the control is
            disabled only at the dataset bounds or when that adjacent slot
            settled `error`. A `loading` neighbour stays enabled and rides the
            existing uxc-2 pending gesture, so the step opens when it lands. The
            step opens the row in this same dock through `onStep` (App's
            existing record-request + grid-scroll seam), so the dock never
            closes and the freshness/epoch rules keep applying. */}
        <button
          type="button"
          className="record-affordance"
          data-testid="record-prev"
          aria-label="Previous row"
          title="Previous row"
          disabled={previousRow === null}
          onClick={() => {
            if (previousRow !== null) onStep(previousRow)
          }}
        >
          <span aria-hidden="true">◀</span> Prev
        </button>
        <button
          type="button"
          className="record-affordance"
          data-testid="record-next"
          aria-label="Next row"
          title="Next row"
          disabled={nextRow === null}
          onClick={() => {
            if (nextRow !== null) onStep(nextRow)
          }}
        >
          <span aria-hidden="true">▶</span> Next
        </button>
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
