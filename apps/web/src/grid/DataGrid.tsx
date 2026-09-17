import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import type { GridViewportModel } from '@assay/grid'
import { formatCell } from './format'
import { nestedActionLabel, nestedActionVerb } from '../sql/nested-actions'
import type { NestedAction } from '../sql/nested-actions'
import { parseDuckDbType } from '../schema/parseType'
import { nextSortSpec } from './query-state'

/** Fixed row height for the DOM renderer (ADR 0022: renderer is replaceable). */
export const GRID_ROW_HEIGHT_PX = 28
/** Extra DOM rows rendered beyond the viewport so scrolling stays ahead of paint. */
const VIRTUALIZER_OVERSCAN_ROWS = 6

interface DataGridProps {
  model: GridViewportModel
  /**
   * m3-3 record inspector affordance: called with the row index when the user
   * clicks a row or presses Enter on a focused row. Omitted = rows are inert
   * (plain render surface). Non-ready rows deliberately no-op: the inspector
   * opens only from a `ready` row (there is no record to show honestly
   * behind the `…`/`!` placeholders).
   */
  onOpenRecord?: (rowIndex: number) => void
  /**
   * m3-5: called when a nested column header's one-click affordance is
   * activated (STRUCT header → flatten, LIST header → explode). The grid
   * only emits the intent; composition + execution live in the SQL pane.
   */
  onNestedAction: (action: NestedAction) => void
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
 * The current sort is indicated by the button's glyph + `data-sort` state.
 * Command rejections (an engine failure mid-epoch) surface as a footer
 * alert — rendered as text only (ADR 0007 spirit; ADR 0025: nothing here
 * ever shows the file name).
 *
 * m3-5: every NESTED column header carries one action button mirroring the
 * column's type — a STRUCT header flattens it, a LIST header explodes it.
 * Entry-point rationale: header real estate is one `minmax(9rem, 1fr)` cell
 * shared with the name and the sort toggle, so a *menu* would crowd it and
 * hide the operation behind a second click; a single typed button per
 * nested column is the whole affordance, and every nested column gets its
 * operation without typing SQL. Path extraction is per-field by nature, so
 * its single entry point is the schema tree — the only surface where each
 * field is individually visible and addressable (the tree also declines to
 * offer extract through list elements, which would need indices it does not
 * carry).
 */
export function DataGrid({ model, onOpenRecord, onNestedAction }: DataGridProps) {
  useSyncExternalStore(model.subscribe, model.getVersion)

  const schema = model.schema ?? []
  const totalRows = model.totalRows ?? 0
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [commandError, setCommandError] = useState<string | null>(null)

  /**
   * m3-5: per-column one-click action, derived from the parsed DESCRIBE type
   * (STRUCT → flatten, LIST → explode; primitives/maps get none — the
   * parser is total, so unknown types simply offer nothing).
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
      // Engine-side failure while rebuilding the epoch — never a UI bug.
      // The provider still holds the attempted sort; rows surface the
      // data-level failure themselves (error placeholders/retry).
      setCommandError(error instanceof Error ? error.message : String(error))
    })
  }

  const virtualizer = useVirtualizer({
    count: totalRows,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => GRID_ROW_HEIGHT_PX,
    overscan: VIRTUALIZER_OVERSCAN_ROWS,
  })
  const virtualItems = virtualizer.getVirtualItems()

  // Drive the model's windowed fetching from the rendered range (inclusive
  // row indices). Keyed on the range string, so model notifications re-render
  // rows but never re-trigger observations — failed spans are retried only
  // when the visible range changes or via the explicit retry button.
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
    schema.length > 0 ? `repeat(${String(schema.length)}, minmax(9rem, 1fr))` : '1fr'
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
      aria-colcount={schema.length}
    >
      <div className="grid-header" role="rowgroup">
        <div className="grid-header-row" role="row" style={{ gridTemplateColumns }}>
          {schema.map((column) => {
            // Active sort indicator: this column's direction when the
            // model's dataset-wide sort names this column, else unsorted.
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
            return (
              <div
                key={item.key}
                role="row"
                aria-rowindex={item.index + 2} // + header row (1-based)
                className={`grid-row grid-row-${status}${
                  onOpenRecord === undefined ? '' : ' grid-row-openable'
                }`}
                data-testid="grid-row"
                data-row-index={item.index}
                data-status={status}
                title={status === 'error' ? slot.message : undefined}
                tabIndex={onOpenRecord === undefined ? undefined : 0}
                onClick={
                  onOpenRecord === undefined
                    ? undefined
                    : () => {
                        onOpenRecord(item.index)
                      }
                }
                onKeyDown={
                  onOpenRecord === undefined
                    ? undefined
                    : (event) => {
                        // Enter on a focused row opens the record inspector
                        // (plain Enter only — modifier combos stay free for
                        // user-agent/browser conventions).
                        if (
                          event.key === 'Enter' &&
                          !event.shiftKey &&
                          !event.ctrlKey &&
                          !event.altKey &&
                          !event.metaKey
                        ) {
                          onOpenRecord(item.index)
                        }
                      }
                }
                style={{
                  ...rowStyle,
                  height: item.size,
                  transform: `translateY(${String(item.start)}px)`,
                }}
              >
                {status === 'ready'
                  ? slot.row.map((cell, columnIndex) => (
                      <div
                        key={columnIndex}
                        role="gridcell"
                        className="grid-cell"
                        data-testid="grid-cell"
                      >
                        {/* m3-2 title policy: cells deliberately carry NO `title`
                            attribute. A title mirroring the cell text would put a
                            copy of every preview into DOM attributes (payload ×
                            cells), and pre-m3-2 it risked multi-KB tooltips over
                            raw JSON.stringify output. Overflow stays a CSS
                            concern (text-overflow: ellipsis); the bounded preview
                            text is the honest visible content; the full value is
                            the m3-3 inspector's job. */}
                        {formatCell(cell)}
                      </div>
                    ))
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
              </div>
            )
          })}
        </div>
      </div>
      <footer className="grid-footer">
        <span data-testid="grid-stats">
          {`fetches=${String(stats.fetchCalls)} requested=${String(stats.rowsRequested)} received=${String(stats.rowsReceived)} maxSpan=${String(stats.maxSpanRows)} cached=${String(stats.cachedRows)}`}
        </span>
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
