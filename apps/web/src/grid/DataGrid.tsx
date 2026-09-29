// SPDX-License-Identifier: AGPL-3.0-or-later

import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import type { GridViewportModel } from '@assay/grid'
import type { CellValue, OverlayState, RowId } from '@assay/domain'
import { NULL_VALUE, parseRowId } from '@assay/domain'
import { formatCell } from './format'
import { nestedActionLabel, nestedActionVerb } from '../sql/nested-actions'
import type { NestedAction } from '../sql/nested-actions'
import { parseDuckDbType } from '../schema/parseType'
import { cellEditDraft, cellEditorKind, validateCellInput } from '../edit/typed-input'
import { nextSortSpec } from './query-state'

/** Fixed row height for the DOM renderer (ADR 0022: renderer is replaceable). */
export const GRID_ROW_HEIGHT_PX = 28
/** Extra DOM rows rendered beyond the viewport so scrolling stays ahead of paint. */
const VIRTUALIZER_OVERSCAN_ROWS = 6

interface DataGridProps {
  model: GridViewportModel
  /**
   * m3-3 record inspector affordance: called with the row index when the user
   * clicks a row or presses Enter on a focused row (with no cell selected for
   * editing). Omitted = rows are inert (plain render surface). The grid emits
   * the gesture for ANY rendered row, ready or not — declining non-ready rows
   * is the record inspector's job.
   */
  onOpenRecord?: (rowIndex: number) => void
  /**
   * m3-5: called when a nested column header's one-click affordance is
   * activated (STRUCT header → flatten, LIST header → explode).
   */
  onNestedAction: (action: NestedAction) => void
  /**
   * m4-3: the folded overlay state. Non-null enables the editing affordances
   * (cell editors, dirty markers, row delete); null keeps the grid read-only
   * (the pre-m4-3 render surface).
   */
  overlayState?: OverlayState | null
  /**
   * m4-3 commit path. The grid emits a logical `RowId` (from the model's
   * opaque key channel) plus the column name and typed value; the app turns
   * it into a `cell-set` op. The grid never mutates data itself (ADR 0012).
   */
  onCommitCell?: (rowId: RowId, column: string, value: CellValue) => void
  /** m4-3 row-delete affordance; emits the row's logical id. */
  onDeleteRow?: (rowId: RowId) => void
  /**
   * q-3: report a client-side edit rejection to the app's single polite
   * live region. The grid keeps its own visible `grid-edit-error` text; the
   * callback mirrors the (value-free) reason into one `aria-live="polite"`
   * region so commit success and rejection share the documented contract.
   */
  onEditAnnounce?: (message: string) => void
  /**
   * m5-3 jump-to-row request: scroll this effective row index into view
   * (align `start`, so the target position is deterministic). `seq` makes
   * repeated requests for the SAME row re-fire; `null` is idle. The request
   * is an immediate gesture — it is not tracked or re-applied across data
   * epochs (a later overlay change can move the row; re-validating
   * refreshes the report's targets).
   */
  scrollRequest?: { readonly rowIndex: number; readonly seq: number } | null
}

/**
 * One in-progress edit: the cell's **logical row identity** (captured at
 * `beginEdit`, never the live position), the column, the raw editor draft,
 * and its initial state. Keying on the logical id is the AR-W1 fix: an
 * accepted sort/filter starts a fresh data epoch and renumbers rows, and a
 * commit must land on the record the user began editing — never on whatever
 * record the old position now holds (ADR 0011).
 */
interface EditingCell {
  readonly rowKey: RowId
  readonly columnIndex: number
  readonly draft: string
  /**
   * The draft the editor opened with (m4-4 temporal-dirty guard): an
   * unchanged draft for a cell that already had a value means "cancel", not
   * "commit a no-op" — double-click + Enter on a DATE/TIMESTAMP/TIME cell
   * must not manufacture a spurious dirty edit.
   */
  readonly initialDraft: string
  /**
   * Whether the cell was NULL when the editor opened. A NULL cell opens with
   * an empty draft, but committing empty text there is a *real* value change
   * (empty string ≠ NULL), so the unchanged-draft cancel never applies to it.
   */
  readonly initialNull: boolean
}

/**
 * The virtualized DOM grid (TanStack Virtual) over the headless viewport
 * model. DOM nodes are bounded by viewport + overscan regardless of dataset
 * size; the model owns fetching, caching, and placeholder semantics. The
 * footer exposes the model's request counters — the observable form of the
 * "never materializes the dataset" guarantee (ADR 0003).
 *
 * m2-3: each column header carries a sort toggle cycling asc → desc →
 * cleared, wired to `model.setSort` (the pure cycle lives in `query-state`).
 *
 * m3-5: every NESTED column header carries one action button mirroring the
 * column's type (STRUCT → flatten, LIST → explode).
 *
 * m4-3 — editing:
 * - **Open**: double-click a cell, or focus a cell (click) and press Enter.
 *   The editor is only offered for non-nested columns; row Enter with no
 *   focused cell keeps opening the record inspector (m3-3).
 * - **Commit**: Enter (or blur) validates the draft against the parsed
 *   column type and emits a typed `CellValue`; Escape cancels and leaves the
 *   overlay untouched. An unchanged draft on a cell that already had a value
 *   is a **cancel** too (m4-4 carry-over: double-click + Enter on a temporal
 *   cell must not manufacture a spurious dirty edit); a NULL cell's empty
 *   draft still commits, because empty text is a real value distinct from
 *   NULL. A rejected draft renders a readable `role="alert"` message and
 *   keeps the editor open — state never changes on rejection.
 * - **NULL**: a dedicated NULL button commits `{ kind: 'null' }`; NULL cells
 *   render as a distinct `NULL` marker (`data-null`), never as an empty
 *   string, an unset editor, or an error.
 * - **Dirty**: an edited cell/row carries `data-dirty="true"`; inserted rows
 *   carry `data-inserted="true"`. After undoing every edit the grid is clean
 *   again (the state is a pure fold of the history cursor).
 * - **Delete**: a per-row trailing affordance emits the row's logical id.
 *
 * Text-only rendering throughout (ADR 0007 spirit; no `dangerouslySetInnerHTML`).
 */
export function DataGrid({
  model,
  onOpenRecord,
  onNestedAction,
  overlayState = null,
  onCommitCell,
  onDeleteRow,
  onEditAnnounce,
  scrollRequest = null,
}: DataGridProps) {
  useSyncExternalStore(model.subscribe, model.getVersion)

  const schema = useMemo(() => model.schema ?? [], [model.schema])
  const totalRows = model.totalRows ?? 0
  /**
   * q-1: parse each column's DuckDB type once per schema, not once per cell
   * per render. This array drives the header nested-actions, the editor kind
   * for every rendered cell, typed input validation, and cell formatting
   * (decimal/object paths) — all of which previously re-parsed `column.type`
   * on every render. The parsed trees are readonly and shared with the
   * memoized parser cache.
   *
   * `schema` must have a stable identity for this memo (and `headerActions`)
   * to hold: the raw `model.schema ?? []` allocated a fresh fallback array on
   * every render while the model was still loading, invalidating both caches
   * until the first load landed. `model.schema` is a stable readonly array
   * between loads/epochs, so memoizing the null-coalesce fixes the churn
   * without a behavior change (f-3).
   */
  const parsedColumnTypes = useMemo(
    () => schema.map((column) => parseDuckDbType(column.type)),
    [schema],
  )
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [commandError, setCommandError] = useState<string | null>(null)
  const [editing, setEditing] = useState<EditingCell | null>(null)
  const [editError, setEditError] = useState<string | null>(null)
  /**
   * Column index the keyboard navigation should carry (the last focused cell),
   * mirrored into a ref because it is an imperative value with no render
   * consumer. It is written synchronously wherever focus moves so an arrow
   * sequence is not coupled to when React commits a focus-triggered render.
   *
   * uxc-1: `onKeyDown` must not rely on this ref alone for Enter. Under load
   * the browser can apply DOM focus to a cell (and dispatch the next keydown)
   * before React has processed the focus event that would write this ref, so
   * Enter resolves its target column from the event's own DOM target instead
   * (see the `onKeyDown` comment). The ref stays the synchronously committed
   * keyboard intent for navigation.
   */
  const focusedColumnRef = useRef<number | null>(null)
  /**
   * S5 roving-tabindex anchor: the effective row index that owns the grid's
   * single `tabIndex=0`. `null` means "not yet entered" and the first
   * rendered row carries the tab stop, so Tab always has an entry point.
   */
  const [focusedRow, setFocusedRow] = useState<number | null>(null)
  /**
   * S5: a parked focus move for a row the virtualizer has not rendered yet.
   * Arrow navigation can target a row outside the current window; the focus
   * effect completes the move once that row exists and then clears this.
   */
  const [focusRequest, setFocusRequest] = useState<{
    readonly rowIndex: number
    readonly columnIndex: number | null
  } | null>(null)
  /**
   * AR-W2: the last `scrollRequest.seq` actually consumed. The jump effect
   * also re-runs on `totalRows` changes (filters/insert/delete); without this
   * guard a consumed request would re-scroll the grid to a now-stale index,
   * contradicting the prop's "immediate gesture" contract.
   */
  const consumedScrollSeq = useRef<number | null>(null)

  const editingEnabled = overlayState !== null && onCommitCell !== undefined
  const rowActionsEnabled = overlayState !== null && onDeleteRow !== undefined
  /**
   * S5: the grid is a keyboard surface when it has any interaction (record
   * open and/or editing). Rows become the roving tab stops and cells become
   * programmatically focusable (`tabIndex=-1`) only in that mode; a pure
   * render surface stays out of the tab order.
   */
  const interactive = onOpenRecord !== undefined || editingEnabled

  /**
   * m3-5: per-column one-click action, derived from the parsed DESCRIBE type
   * (STRUCT → flatten, LIST → explode; primitives/maps get none). Uses the
   * per-schema parsed types computed above (q-1).
   */
  const headerActions = useMemo(() => {
    const actions = new Map<string, NestedAction>()
    schema.forEach((column, index) => {
      const parsed = parsedColumnTypes[index]
      if (parsed === undefined) return
      if (parsed.kind === 'struct')
        actions.set(column.name, { kind: 'flatten', column: column.name })
      if (parsed.kind === 'list') actions.set(column.name, { kind: 'explode', column: column.name })
    })
    return actions
  }, [schema, parsedColumnTypes])

  const cycleSort = (columnName: string): void => {
    setCommandError(null)
    model.setSort(nextSortSpec(model.sort, columnName)).catch((error: unknown) => {
      setCommandError(error instanceof Error ? error.message : String(error))
    })
  }

  const beginEdit = (rowIndex: number, columnIndex: number): void => {
    if (!editingEnabled) return
    const column = schema[columnIndex]
    if (column === undefined) return
    const parsedType = parsedColumnTypes[columnIndex]
    if (parsedType === undefined) return
    const kind = cellEditorKind(parsedType)
    if (kind === 'unsupported') {
      const message = `Column "${column.name}" is not editable (nested type).`
      setEditError(message)
      onEditAnnounce?.(message)
      return
    }
    const slot = model.getRow(rowIndex)
    if (slot.status !== 'ready' || slot.key === undefined) return
    const cell = slot.row[columnIndex]
    const initialDraft = cellEditDraft(cell, parsedType)
    setEditError(null)
    setEditing({
      rowKey: slot.key as RowId,
      columnIndex,
      // Temporal cells cross the engine boundary as epoch numbers; the draft
      // is formatted human-readably and engine-round-trippably (typed-input).
      draft: initialDraft,
      initialDraft,
      initialNull: cell === null || cell === undefined,
    })
  }

  const cancelEdit = (): void => {
    setEditing(null)
    setEditError(null)
  }

  const commitEditValue = (value: CellValue): void => {
    if (editing === null) return
    const column = schema[editing.columnIndex]
    if (column !== undefined && onCommitCell !== undefined) {
      // The logical row id captured when the editor opened (AR-W1): a sort/
      // filter that ran while the editor was open renumbered positions, so
      // resolving the id from `rowIndex` here would target a different record.
      onCommitCell(editing.rowKey, column.name, value)
    }
    setEditing(null)
    setEditError(null)
  }

  const commitEditDraft = (): void => {
    if (editing === null) return
    const column = schema[editing.columnIndex]
    if (column === undefined) {
      cancelEdit()
      return
    }
    // Temporal/any unchanged draft on a non-NULL cell is a cancel, not a
    // commit: the editor opened with the current value, so no edit happened.
    // (A NULL cell's empty draft is *not* the current value — empty text is a
    // real value distinct from NULL — so it still commits.)
    if (!editing.initialNull && editing.draft === editing.initialDraft) {
      cancelEdit()
      return
    }
    const parsedType = parsedColumnTypes[editing.columnIndex]
    if (parsedType === undefined) {
      cancelEdit()
      return
    }
    const parsed = validateCellInput(parsedType, editing.draft)
    if (!parsed.ok) {
      // Readable rejection; overlay state is untouched and the editor stays
      // open so the user can correct the value. The reason is a value-free
      // class (justify: typed-input.test.ts), so it is also safe to announce
      // through the app's polite live region (q-3, ADR 0025).
      setEditError(parsed.reason)
      onEditAnnounce?.(parsed.reason)
      return
    }
    commitEditValue(parsed.value)
  }

  /**
   * Measured height of the pinned header. The header now lives inside the
   * scroll element so header and body share ONE horizontal scroll context,
   * which means the virtualizer must offset for it: `scrollMargin` keeps the
   * range math and `scrollToIndex` offsets in content coordinates, and
   * `scrollPaddingStart` keeps an aligned row just below the pinned header.
   * Measuring keeps this correct across themes, zoom, and font metrics rather
   * than hardcoding a row height (ADR 0022: the renderer stays replaceable).
   *
   * uxc-5 (c): `useLayoutEffect` measures synchronously before the browser
   * paints, so the first committed frame already carries the real
   * `scrollMargin`/`scrollPaddingStart`. With `useEffect` the initial paint
   * ran with both at 0, leaving a one-frame row-0-under-header window. The app
   * is browser-only (no SSR in this composition root), so the layout-effect
   * SSR warning does not apply.
   */
  const headerRef = useRef<HTMLDivElement | null>(null)
  const [headerHeight, setHeaderHeight] = useState(0)
  useLayoutEffect(() => {
    const element = headerRef.current
    if (element === null) return
    const measure = (): void => {
      setHeaderHeight(element.getBoundingClientRect().height)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }, [])

  const virtualizer = useVirtualizer({
    count: totalRows,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => GRID_ROW_HEIGHT_PX,
    overscan: VIRTUALIZER_OVERSCAN_ROWS,
    scrollMargin: headerHeight,
    scrollPaddingStart: headerHeight,
  })
  const virtualItems = virtualizer.getVirtualItems()
  /**
   * S5: exactly one row carries `tabIndex=0`. Prefer the last focused row
   * while it is rendered; otherwise the first rendered row keeps the grid
   * Tab-reachable after a scroll unmounts the remembered row.
   */
  const tabbableRowIndex =
    focusedRow !== null && virtualItems.some((item) => item.index === focusedRow)
      ? focusedRow
      : (virtualItems[0]?.index ?? 0)

  // m5-3 jump-to-row: a new scroll request scrolls the target row to the top
  // of the grid viewport AND brings it into the browser viewport (the grid
  // sits below stacked panels, and a jump the user cannot see is not a
  // jump). Out-of-range requests are ignored (the caller resolves row keys
  // against the same model, so this is a race guard, not a feature).
  useEffect(() => {
    if (scrollRequest === null) return
    // AR-W2: consume each request exactly once. The effect re-runs when
    // `totalRows` changes; a consumed request must never re-fire.
    if (consumedScrollSeq.current === scrollRequest.seq) return
    if (scrollRequest.rowIndex < 0 || scrollRequest.rowIndex >= totalRows) return
    consumedScrollSeq.current = scrollRequest.seq
    virtualizer.scrollToIndex(scrollRequest.rowIndex, { align: 'start' })
    // One rAF later the virtualizer has re-rendered the target window, so
    // the row element exists; scrolling it to the viewport center moves only
    // the ancestor scrollables (the page, if the grid is below the fold).
    const raf = requestAnimationFrame(() => {
      const element = scrollRef.current?.querySelector(
        `[data-row-index="${String(scrollRequest.rowIndex)}"]`,
      )
      element?.scrollIntoView({ block: 'center' })
    })
    return () => {
      cancelAnimationFrame(raf)
    }
  }, [scrollRequest, virtualizer, totalRows])

  const rangeKey =
    virtualItems.length > 0
      ? `${String(virtualItems[0].index)}:${String(virtualItems[virtualItems.length - 1].index)}`
      : ''
  useEffect(() => {
    if (rangeKey === '') return
    const separator = rangeKey.indexOf(':')
    model.observeViewport(
      Number(rangeKey.slice(0, separator)),
      Number(rangeKey.slice(separator + 1)),
    )
  }, [model, rangeKey])

  // S5: completes a roving-focus move once the target row is in the DOM.
  // Arrow navigation can target a row the virtualizer has not rendered yet,
  // so the request is retried on each `virtualItems` change and cleared after
  // the focus lands (later renders never steal focus from the pointer).
  // AR-W2 bounds discipline: if the dataset shrank past the parked index
  // (filter/delete landing between park and render), the request is dropped —
  // a positional index from a superseded row set must never steal focus when
  // a later render re-exposes that index.
  useEffect(() => {
    if (focusRequest === null) return
    if (focusRequest.rowIndex >= totalRows) {
      setFocusRequest(null)
      return
    }
    const container = scrollRef.current
    if (container === null) return
    const rowElement = container.querySelector<HTMLElement>(
      `[data-row-index="${String(focusRequest.rowIndex)}"]`,
    )
    if (rowElement === null) return
    let target: HTMLElement = rowElement
    if (focusRequest.columnIndex !== null) {
      const cells = rowElement.querySelectorAll<HTMLElement>('[data-testid="grid-cell"]')
      target = cells[focusRequest.columnIndex] ?? rowElement
    }
    target.focus()
    // `block/inline: nearest` keeps the move minimal and never jumps the page.
    target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    setFocusRequest(null)
  }, [focusRequest, virtualItems, totalRows])

  /**
   * S5 roving-focus movement. Only rendered rows can take DOM focus, so when
   * the target row is outside the current virtual window the request is parked
   * until the virtualizer renders it (the focus effect above re-runs on the
   * next `virtualItems` change). Cells stay `tabIndex=-1`: the row remains the
   * grid's single tab stop whether row focus or cell focus is active.
   */
  const moveGridFocus = (rowIndex: number, columnIndex: number | null): void => {
    if (totalRows === 0) return
    const targetRow = Math.max(0, Math.min(rowIndex, totalRows - 1))
    const targetColumn =
      columnIndex === null ? null : Math.max(0, Math.min(columnIndex, schema.length - 1))
    setFocusedRow(targetRow)
    focusedColumnRef.current = targetColumn
    if (!virtualItems.some((item) => item.index === targetRow)) {
      // `auto` scrolls only when the target is outside the viewport.
      virtualizer.scrollToIndex(targetRow, { align: 'auto' })
    }
    setFocusRequest({ rowIndex: targetRow, columnIndex: targetColumn })
  }

  const stats = model.stats
  const gridTemplateColumns =
    schema.length > 0
      ? `repeat(${String(schema.length)}, minmax(9rem, 1fr))${rowActionsEnabled ? ' 5rem' : ''}`
      : '1fr'
  /**
   * Deterministic track floor shared by the header row and every body row: a
   * wide container stretches the `1fr` tracks equally, and a narrow container
   * pans exact 9rem tracks inside the scroll element — never clipping. Both
   * regimes use the identical floor, so header and cells stay aligned.
   */
  const gridMinWidth =
    schema.length > 0
      ? `calc(${String(schema.length)} * 9rem${rowActionsEnabled ? ' + 5rem' : ''})`
      : undefined
  const rowStyle: CSSProperties = {
    display: 'grid',
    gridTemplateColumns,
    minWidth: gridMinWidth,
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
  }

  return (
    <div className="grid" data-testid="grid">
      {/* ux-3 (UX-7): the Grid section's heading. It sits outside the role=grid
          element, whose owned children must be rows/rowgroups. */}
      <h2 className="visually-hidden">Grid</h2>
      {/* ux-3 (UX-9): role=grid lives on the SCROLL VIEWPORT (the element that
          actually owns the rowgroups), not on the outer `.grid` container.
          The footer's `<details>` disclosure has ARIA role `group`, and axe's
          `aria-required-children` treats any non-row/rowgroup owned descendant
          of a grid as an unallowed child — so the footer must sit outside the
          grid role. The grid semantics are unchanged: the viewport's children
          are the header rowgroup + the body rowgroup. */}
      <div
        className="grid-viewport"
        data-testid="grid-viewport"
        ref={scrollRef}
        role="grid"
        aria-rowcount={totalRows + 1}
        aria-colcount={schema.length + (rowActionsEnabled ? 1 : 0)}
      >
        <div className="grid-header" role="rowgroup" ref={headerRef}>
          <div
            className="grid-header-row"
            role="row"
            style={{ gridTemplateColumns, minWidth: gridMinWidth }}
          >
            {schema.map((column) => {
              const sortDirection = model.sort?.column === column.name ? model.sort.direction : null
              const sortLabel =
                sortDirection === null
                  ? `Sort by ${column.name}`
                  : `Sort by ${column.name} (currently ${sortDirection === 'asc' ? 'ascending' : 'descending'})`
              const headerAction = headerActions.get(column.name)
              const headerActionLabel =
                headerAction === undefined ? '' : nestedActionLabel(headerAction)
              return (
                <div
                  key={column.name}
                  className="grid-header-cell"
                  role="columnheader"
                  data-testid="grid-header-cell"
                  data-col-name={column.name}
                  data-col-type={column.type}
                  title={`${column.name}: ${column.type}`}
                >
                  <span className="grid-header-name" data-testid="grid-header-name">
                    {column.name}
                  </span>
                  <button
                    type="button"
                    className="grid-sort-toggle"
                    data-testid="grid-sort-toggle"
                    data-col-name={column.name}
                    data-sort={sortDirection ?? 'none'}
                    aria-label={sortLabel}
                    title={sortLabel}
                    onClick={() => {
                      cycleSort(column.name)
                    }}
                  >
                    <span aria-hidden="true">
                      {sortDirection === 'asc' ? '▲' : sortDirection === 'desc' ? '▼' : '↕'}
                    </span>
                  </button>
                  {headerAction !== undefined && (
                    <button
                      type="button"
                      className="grid-nested-action"
                      data-testid="grid-header-nested-action"
                      data-col-name={column.name}
                      data-grid-action={headerAction.kind}
                      aria-label={headerActionLabel}
                      title={headerActionLabel}
                      onClick={() => {
                        onNestedAction(headerAction)
                      }}
                    >
                      {nestedActionVerb(headerAction)}
                    </button>
                  )}
                </div>
              )
            })}
            {rowActionsEnabled && (
              <div
                className="grid-header-cell grid-actions-header"
                role="columnheader"
                data-testid="grid-actions-header"
                aria-label="Row actions"
              >
                {/*
                 * pt0-4 residue (q-3): a `columnheader` needs inner text that
                 * is visible to screen readers — `aria-label` alone does not
                 * satisfy axe `empty-table-header`. The visible header stays
                 * blank; the screen-reader text names the actions column.
                 */}
                <span className="visually-hidden">Row actions</span>
              </div>
            )}
          </div>
        </div>
        <div
          role="rowgroup"
          style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}
        >
          {virtualItems.map((item) => {
            const slot = model.getRow(item.index)
            const status = slot.status
            const rowId = status === 'ready' && slot.key !== undefined ? (slot.key as RowId) : null
            const rowEdits =
              rowId !== null && overlayState !== null
                ? (overlayState.edits.get(rowId) ?? null)
                : null
            const inserted = rowId !== null && parseRowId(rowId)?.origin === 'insert'
            const rowDirty = inserted || (rowEdits !== null && rowEdits.size > 0)
            return (
              <div
                key={item.key}
                role="row"
                aria-rowindex={item.index + 2}
                className={`grid-row grid-row-${status}${
                  onOpenRecord === undefined ? '' : ' grid-row-openable'
                }${rowDirty ? ' grid-row-dirty' : ''}`}
                data-testid="grid-row"
                data-row-index={item.index}
                data-status={status}
                data-dirty={rowDirty ? 'true' : 'false'}
                data-inserted={inserted ? 'true' : undefined}
                title={status === 'error' ? slot.message : undefined}
                tabIndex={interactive ? (item.index === tabbableRowIndex ? 0 : -1) : undefined}
                onClick={
                  onOpenRecord === undefined
                    ? undefined
                    : () => {
                        onOpenRecord(item.index)
                      }
                }
                onFocus={(event) => {
                  // Row-level focus (not a bubbled cell focus) is the roving
                  // tab stop's resting position: remember the row and drop the
                  // carried cell column so Enter keeps opening the inspector.
                  if (event.target === event.currentTarget) {
                    setFocusedRow(item.index)
                    focusedColumnRef.current = null
                  }
                }}
                onKeyDown={(event) => {
                  // uxc-1 root cause and fix. This handler used to read the
                  // `focusedColumn` state captured by the render closure. A
                  // cell's `.focus()` sets DOM focus synchronously, but the
                  // `onFocus` state commit — and the re-render that produces a
                  // fresh `onKeyDown` closure — can lag behind the very next
                  // keydown under load. Enter then saw the previous value
                  // (commonly `null`) and opened the record inspector instead
                  // of the editor, so `grid-editor-input` never appeared (the
                  // intermittent a11y-keyboard timeout). A keydown is always
                  // delivered to the element that actually owns DOM focus, so
                  // the event target is the committed truth: resolve the
                  // target column from the focused cell's `data-col-index`, and
                  // treat a row-targeted keydown as "no cell". This is
                  // independent of React state/ref timing.
                  const target = event.target
                  // uxc-1 round 2 (reviewer): a keydown originating inside an
                  // open editor belongs to that editor. The text input consumes
                  // Enter/Escape itself, but the boolean `<select>` and the NULL
                  // button let them bubble to this row handler; before this
                  // guard a bubbled Enter fell through to the inspector gesture
                  // below. Contain on the event target (an ancestor editor
                  // wrapper) as well as on `editing`, so the check does not
                  // depend on when the edit state commits.
                  if (
                    editing !== null ||
                    (target instanceof HTMLElement && target.closest('.grid-cell-editor') !== null)
                  ) {
                    return
                  }
                  const targetColumn =
                    target instanceof HTMLElement &&
                    target !== event.currentTarget &&
                    target.dataset.colIndex !== undefined
                      ? Number(target.dataset.colIndex)
                      : null
                  // Navigation resolves the column the same committed-truth way
                  // as Enter: the keydown's own DOM target first, then the
                  // synchronously mirrored keyboard intent (so a rapid arrow
                  // sequence does not depend on when the focus effect lands).
                  const arrowColumn = targetColumn ?? focusedColumnRef.current
                  if (event.key === 'Enter') {
                    if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) {
                      return
                    }
                    // Enter on a focused cell edits it; Enter on the row (no
                    // cell focused) keeps the m3-3 inspector gesture.
                    if (targetColumn !== null && editingEnabled) {
                      beginEdit(item.index, targetColumn)
                    } else if (onOpenRecord !== undefined) {
                      onOpenRecord(item.index)
                    }
                    return
                  }
                  // S5 navigation. An open editor consumes its own arrow/Home/
                  // End keys (text caret, select options), so never steal focus
                  // while editing — Enter/Escape semantics are untouched.
                  if (editing !== null || !interactive || schema.length === 0) return
                  const lastColumn = schema.length - 1
                  switch (event.key) {
                    case 'ArrowDown':
                      event.preventDefault()
                      moveGridFocus(Math.min(item.index + 1, totalRows - 1), arrowColumn)
                      return
                    case 'ArrowUp':
                      event.preventDefault()
                      moveGridFocus(Math.max(item.index - 1, 0), arrowColumn)
                      return
                    case 'ArrowRight':
                      event.preventDefault()
                      moveGridFocus(
                        item.index,
                        arrowColumn === null ? 0 : Math.min(arrowColumn + 1, lastColumn),
                      )
                      return
                    case 'ArrowLeft':
                      event.preventDefault()
                      moveGridFocus(
                        item.index,
                        arrowColumn === null ? lastColumn : Math.max(arrowColumn - 1, 0),
                      )
                      return
                    case 'Home':
                      event.preventDefault()
                      moveGridFocus(event.ctrlKey || event.metaKey ? 0 : item.index, 0)
                      return
                    case 'End':
                      event.preventDefault()
                      moveGridFocus(
                        event.ctrlKey || event.metaKey ? totalRows - 1 : item.index,
                        lastColumn,
                      )
                      return
                    default:
                      return
                  }
                }}
                style={{
                  ...rowStyle,
                  height: item.size,
                  transform: `translateY(${String(item.start - headerHeight)}px)`,
                }}
              >
                {status === 'ready'
                  ? slot.row.map((cell, columnIndex) => {
                      const column = schema[columnIndex]
                      // Follow the logical row (AR-W1): after an epoch shift
                      // the editor renders on the captured row's new position
                      // and disappears if that row is no longer in the view.
                      const isEditing =
                        editing !== null &&
                        rowId !== null &&
                        editing.rowKey === rowId &&
                        editing.columnIndex === columnIndex
                      const dirty = rowEdits?.has(column?.name ?? '') ?? false
                      const isNull = cell === null || cell === undefined
                      const parsedType =
                        column === undefined ? undefined : parsedColumnTypes[columnIndex]
                      const kind =
                        parsedType === undefined ? 'unsupported' : cellEditorKind(parsedType)
                      return (
                        <div
                          key={columnIndex}
                          role="gridcell"
                          className={`grid-cell${dirty ? ' grid-cell-dirty' : ''}${
                            isNull ? ' grid-cell-null' : ''
                          }`}
                          data-testid="grid-cell"
                          data-col-name={column?.name}
                          data-col-index={columnIndex}
                          data-dirty={dirty ? 'true' : 'false'}
                          data-null={isNull ? 'true' : undefined}
                          tabIndex={interactive && !isEditing ? -1 : undefined}
                          onFocus={(event) => {
                            if (event.target === event.currentTarget && interactive) {
                              setFocusedRow(item.index)
                              focusedColumnRef.current = columnIndex
                            }
                          }}
                          onDoubleClick={
                            editingEnabled
                              ? (event) => {
                                  event.stopPropagation()
                                  beginEdit(item.index, columnIndex)
                                }
                              : undefined
                          }
                        >
                          {isEditing && column !== undefined ? (
                            kind === 'boolean' ? (
                              <span
                                className="grid-cell-editor"
                                data-testid="grid-cell-editor"
                                onClick={(event) => {
                                  event.stopPropagation()
                                }}
                              >
                                <select
                                  className="grid-editor-input"
                                  data-testid="grid-editor-boolean"
                                  aria-label={`Edit ${column.name} on row ${String(item.index)}`}
                                  autoFocus
                                  value={editing.draft === '' ? '' : editing.draft}
                                  onChange={(event) => {
                                    const next = event.target.value
                                    if (next === 'true') {
                                      commitEditValue({ kind: 'boolean', value: true })
                                    } else if (next === 'false') {
                                      commitEditValue({ kind: 'boolean', value: false })
                                    } else {
                                      setEditing({ ...editing, draft: next })
                                    }
                                  }}
                                  onKeyDown={(event) => {
                                    if (event.key === 'Escape') {
                                      event.preventDefault()
                                      event.stopPropagation()
                                      cancelEdit()
                                    }
                                  }}
                                >
                                  <option value="">true / false…</option>
                                  <option value="true">true</option>
                                  <option value="false">false</option>
                                </select>
                                <button
                                  type="button"
                                  className="grid-editor-null"
                                  data-testid="grid-editor-null"
                                  onMouseDown={(event) => {
                                    event.preventDefault()
                                  }}
                                  onClick={() => {
                                    commitEditValue(NULL_VALUE)
                                  }}
                                >
                                  NULL
                                </button>
                              </span>
                            ) : (
                              <span
                                className="grid-cell-editor"
                                data-testid="grid-cell-editor"
                                onClick={(event) => {
                                  event.stopPropagation()
                                }}
                              >
                                <input
                                  className="grid-editor-input"
                                  data-testid="grid-editor-input"
                                  aria-label={`Edit ${column.name} on row ${String(item.index)}`}
                                  autoFocus
                                  spellCheck={false}
                                  autoComplete="off"
                                  value={editing.draft}
                                  onChange={(event) => {
                                    setEditing({ ...editing, draft: event.target.value })
                                  }}
                                  onKeyDown={(event) => {
                                    if (event.key === 'Enter') {
                                      event.preventDefault()
                                      event.stopPropagation()
                                      commitEditDraft()
                                    } else if (event.key === 'Escape') {
                                      event.preventDefault()
                                      event.stopPropagation()
                                      cancelEdit()
                                    }
                                  }}
                                  onBlur={commitEditDraft}
                                />
                                <button
                                  type="button"
                                  className="grid-editor-null"
                                  data-testid="grid-editor-null"
                                  onMouseDown={(event) => {
                                    // Keep the input focused: a blur here would
                                    // commit the draft before the NULL click.
                                    event.preventDefault()
                                  }}
                                  onClick={() => {
                                    commitEditValue(NULL_VALUE)
                                  }}
                                >
                                  NULL
                                </button>
                              </span>
                            )
                          ) : isNull ? (
                            <span className="grid-null-marker" data-testid="grid-cell-null">
                              NULL
                            </span>
                          ) : (
                            // m3-2 title policy: cells deliberately carry NO
                            // `title` attribute (payload × cells; CSS overflow
                            // is the display concern; the inspector shows full values).
                            formatCell(cell, column?.type, parsedType ?? null)
                          )}
                        </div>
                      )
                    })
                  : schema.map((_, columnIndex) => (
                      <div
                        key={columnIndex}
                        role="gridcell"
                        className="grid-cell"
                        data-testid="grid-cell"
                        data-col-index={columnIndex}
                        tabIndex={interactive ? -1 : undefined}
                        onFocus={(event) => {
                          if (event.target === event.currentTarget && interactive) {
                            setFocusedRow(item.index)
                            focusedColumnRef.current = columnIndex
                          }
                        }}
                      >
                        {status === 'loading' ? '…' : '!'}
                      </div>
                    ))}
                {rowActionsEnabled && status === 'ready' && rowId !== null && (
                  // pt0-4 round-2: the per-row delete control is the grid's
                  // trailing actions column. aria-colcount already includes it
                  // (schema.length + 1 above), so the cell only needs the
                  // gridchild role for role="row" to be conforming.
                  <div className="grid-row-actions" role="gridcell" data-testid="grid-row-actions">
                    <button
                      type="button"
                      className="grid-row-delete"
                      data-testid="grid-row-delete"
                      data-row-index={item.index}
                      aria-label={`Delete row ${String(item.index)}`}
                      title={`Delete row ${String(item.index)}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        onDeleteRow(rowId)
                      }}
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
      <footer className="grid-footer">
        {/* ux-3 (UX-9): request counters are diagnostics, not user copy —
            collapsed by default behind a native disclosure. Kept out of the
            role=grid element (see the viewport comment above). The shared
            `grid-stats` reader reads the span's `textContent`, which is
            independent of the open state. */}
        <details className="grid-diagnostics" data-testid="grid-diagnostics">
          <summary>Diagnostics</summary>
          <span data-testid="grid-stats">
            {`fetches=${String(stats.fetchCalls)} requested=${String(stats.rowsRequested)} received=${String(stats.rowsReceived)} maxSpan=${String(stats.maxSpanRows)} cached=${String(stats.cachedRows)}`}
          </span>
        </details>
        {editError !== null && (
          // q-3: the visible rejection text is not itself a live region; the
          // app's single `aria-live="polite"` region announces it (value-free)
          // so commit success and rejection share one contract.
          <span data-testid="grid-edit-error">{editError}</span>
        )}
        {commandError !== null && (
          <span role="alert" data-testid="grid-command-error">
            {commandError}
          </span>
        )}
        {stats.failedSpans > 0 && (
          <button type="button" data-testid="grid-retry" onClick={() => model.retry()}>
            Retry {stats.failedSpans} failed window{stats.failedSpans === 1 ? '' : 's'}
          </button>
        )}
      </footer>
    </div>
  )
}
