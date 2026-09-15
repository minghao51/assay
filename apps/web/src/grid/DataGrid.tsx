import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import type { GridViewportModel } from '@assay/grid'
import { formatCell } from './format'

/** Fixed row height for the DOM renderer (ADR 0022: renderer is replaceable). */
export const GRID_ROW_HEIGHT_PX = 28
/** Extra DOM rows rendered beyond the viewport so scrolling stays ahead of paint. */
const VIRTUALIZER_OVERSCAN_ROWS = 6

interface DataGridProps {
  model: GridViewportModel
}

/**
 * The virtualized DOM grid (TanStack Virtual) over the headless viewport
 * model. DOM nodes are bounded by viewport + overscan regardless of dataset
 * size; the model owns fetching, caching, and placeholder semantics. The
 * footer exposes the model's request counters — the observable form of the
 * "never materializes the dataset" guarantee (ADR 0003).
 */
export function DataGrid({ model }: DataGridProps) {
  useSyncExternalStore(model.subscribe, model.getVersion)

  const schema = model.schema ?? []
  const totalRows = model.totalRows ?? 0
  const scrollRef = useRef<HTMLDivElement | null>(null)

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
          {schema.map((column) => (
            <div
              key={column.name}
              className="grid-header-cell"
              role="columnheader"
              data-testid="grid-header-cell"
              data-col-name={column.name}
              data-col-type={column.type}
              title={`${column.name}: ${column.type}`}
            >
              {column.name}
            </div>
          ))}
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
                className={`grid-row grid-row-${status}`}
                data-testid="grid-row"
                data-row-index={item.index}
                data-status={status}
                title={status === 'error' ? slot.message : undefined}
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
        {stats.failedSpans > 0 && (
          <button type="button" data-testid="grid-retry" onClick={() => model.retry()}>
            Retry {stats.failedSpans} failed window{stats.failedSpans === 1 ? '' : 's'}
          </button>
        )}
      </footer>
    </section>
  )
}
