import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
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
}

/** One in-progress edit: which cell, the raw editor draft, and its initial state. */
interface EditingCell {
  readonly rowIndex: number
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
}: DataGridProps) {
  useSyncExternalStore(model.subscribe, model.getVersion)

  const schema = model.schema ?? []
  const totalRows = model.totalRows ?? 0
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [commandError, setCommandError] = useState<string | null>(null)
  const [editing, setEditing] = useState<EditingCell | null>(null)
  const [editError, setEditError] = useState<string | null>(null)
  /** Column index of the last focused/clicked cell (Enter-to-edit target). */
  const [focusedColumn, setFocusedColumn] = useState<number | null>(null)

  const editingEnabled = overlayState !== null && onCommitCell !== undefined
  const rowActionsEnabled = overlayState !== null && onDeleteRow !== undefined

  /**
   * m3-5: per-column one-click action, derived from the parsed DESCRIBE type
   * (STRUCT → flatten, LIST → explode; primitives/maps get none).
   */
  const headerActions = useMemo(() => {
    const actions = new Map<string, NestedAction>()
    for (const column of schema) {
      const kind = parseDuckDbType(column.type).kind
      if (kind === 'struct') actions.set(column.name, { kind: 'flatten', column: column.name })
      if (kind === 'list') actions.set(column.name, { kind: 'explode', column: column.name })
    }
    return actions
  }, [schema])

  const cycleSort = (columnName: string): void => {
    setCommandError(null)
    model.setSort(nextSortSpec(model.sort, columnName)).catch((error: unknown) => {
      setCommandError(error instanceof Error ? error.message : String(error))
    })
  }

  /** The logical row id of a rendered row, when the provider supplied one. */
  const rowIdAt = (rowIndex: number): RowId | null => {
    const slot = model.getRow(rowIndex)
    if (slot.status !== 'ready' || slot.key === undefined) return null
    return slot.key as RowId
  }

  const beginEdit = (rowIndex: number, columnIndex: number): void => {
    if (!editingEnabled) return
    const column = schema[columnIndex]
    if (column === undefined) return
    const parsedType = parseDuckDbType(column.type)
    const kind = cellEditorKind(parsedType)
    if (kind === 'unsupported') {
      setEditError(`Column "${column.name}" is not editable (nested type).`)
      return
    }
    const slot = model.getRow(rowIndex)
    if (slot.status !== 'ready' || slot.key === undefined) return
    const cell = slot.row[columnIndex]
    const initialDraft = cellEditDraft(cell, parsedType)
    setEditError(null)
    setEditing({
      rowIndex,
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
    const rowId = rowIdAt(editing.rowIndex)
    if (column !== undefined && rowId !== null && onCommitCell !== undefined) {
      onCommitCell(rowId, column.name, value)
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
    const parsed = validateCellInput(parseDuckDbType(column.type), editing.draft)
    if (!parsed.ok) {
      // Readable rejection; overlay state is untouched and the editor stays
      // open so the user can correct the value.
      setEditError(parsed.reason)
      return
    }
    commitEditValue(parsed.value)
  }

  const virtualizer = useVirtualizer({
    count: totalRows,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => GRID_ROW_HEIGHT_PX,
    overscan: VIRTUALIZER_OVERSCAN_ROWS,
  })
  const virtualItems = virtualizer.getVirtualItems()

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

  const stats = model.stats
  const gridTemplateColumns =
    schema.length > 0
      ? `repeat(${String(schema.length)}, minmax(9rem, 1fr))${rowActionsEnabled ? ' 5rem' : ''}`
      : '1fr'
  const rowStyle: CSSProperties = {
    display: 'grid',
    gridTemplateColumns,
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
  }

  return (
    <section
      className="grid"
      data-testid="grid"
      role="grid"
      aria-rowcount={totalRows + 1}
      aria-colcount={schema.length + (rowActionsEnabled ? 1 : 0)}
    >
      <div className="grid-header" role="rowgroup">
        <div className="grid-header-row" role="row" style={{ gridTemplateColumns }}>
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
            />
          )}
        </div>
      </div>
      <div className="grid-viewport" data-testid="grid-viewport" ref={scrollRef}>
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
                tabIndex={onOpenRecord === undefined && !editingEnabled ? undefined : 0}
                onClick={
                  onOpenRecord === undefined
                    ? undefined
                    : () => {
                        onOpenRecord(item.index)
                      }
                }
                onKeyDown={(event) => {
                  if (
                    event.key !== 'Enter' ||
                    event.shiftKey ||
                    event.ctrlKey ||
                    event.altKey ||
                    event.metaKey
                  ) {
                    return
                  }
                  // Enter on a focused cell edits it; Enter on the row (no
                  // cell focused) keeps the m3-3 inspector gesture.
                  if (focusedColumn !== null && editingEnabled) {
                    beginEdit(item.index, focusedColumn)
                  } else if (onOpenRecord !== undefined) {
                    onOpenRecord(item.index)
                  }
                }}
                style={{
                  ...rowStyle,
                  height: item.size,
                  transform: `translateY(${String(item.start)}px)`,
                }}
              >
                {status === 'ready'
                  ? slot.row.map((cell, columnIndex) => {
                      const column = schema[columnIndex]
                      const isEditing =
                        editing !== null &&
                        editing.rowIndex === item.index &&
                        editing.columnIndex === columnIndex
                      const dirty = rowEdits?.has(column?.name ?? '') ?? false
                      const isNull = cell === null || cell === undefined
                      const kind =
                        column === undefined
                          ? 'unsupported'
                          : cellEditorKind(parseDuckDbType(column.type))
                      return (
                        <div
                          key={columnIndex}
                          role="gridcell"
                          className={`grid-cell${dirty ? ' grid-cell-dirty' : ''}${
                            isNull ? ' grid-cell-null' : ''
                          }`}
                          data-testid="grid-cell"
                          data-col-name={column?.name}
                          data-dirty={dirty ? 'true' : 'false'}
                          data-null={isNull ? 'true' : undefined}
                          tabIndex={editingEnabled && !isEditing ? -1 : undefined}
                          onFocus={(event) => {
                            if (event.target === event.currentTarget && editingEnabled) {
                              setFocusedColumn(columnIndex)
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
                            formatCell(cell)
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
                      >
                        {status === 'loading' ? '…' : '!'}
                      </div>
                    ))}
                {rowActionsEnabled && status === 'ready' && rowId !== null && (
                  <div className="grid-row-actions" data-testid="grid-row-actions">
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
        <span data-testid="grid-stats">
          {`fetches=${String(stats.fetchCalls)} requested=${String(stats.rowsRequested)} received=${String(stats.rowsReceived)} maxSpan=${String(stats.maxSpanRows)} cached=${String(stats.cachedRows)}`}
        </span>
        {editError !== null && (
          <span role="alert" data-testid="grid-edit-error">
            {editError}
          </span>
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
    </section>
  )
}
