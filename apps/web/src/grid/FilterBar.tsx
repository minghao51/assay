// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, useSyncExternalStore } from 'react'
import type { FilterSpec, GridViewportModel } from '@assay/grid'
import { domId } from '../lib/dom-id'
import { replaceColumnFilter } from './query-state'

interface FilterBarProps {
  model: GridViewportModel
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Collision-safe DOM id for a column's filter input (AR-W11). Column names
 * can contain any characters and the old `[^A-Za-z0-9_-] → -` mapping made
 * distinct names collide (`a.b` and `a-b` both became `a-b`), so a label
 * could point at another column's input. Delegates to the shared injective
 * id grammar in `lib/dom-id.ts` (one grammar app-wide).
 */
export function filterInputId(columnName: string): string {
  return domId('filter-input', columnName)
}

/**
 * Per-column filter predicate editor (m2-3). One text input per schema
 * column; the draft is a **column-qualified engine-SQL fragment** applied as
 * `("column" <predicate>)` — the v1 grammar recorded on `FilterSpec` and
 * spelled out in the visible hint. Applying (button or Enter) replaces the
 * whole filter list through `GridViewportModel.setFilters` (clear-first
 * protocol); the active list renders as dismissible chips mirrored from
 * `model.filters`.
 *
 * Error handling: an invalid fragment rejects at the engine while the
 * model's refresh re-reads the filtered total. The rejection is caught, the
 * last accepted list is restored through the model (so rejections leave the
 * previous filter state in effect, per the grid contract), and the engine's
 * own message is surfaced as a text-only alert (ADR 0007 spirit — predicate
 * fragments and engine errors are untrusted *content*, never markup; ADR
 * 0025 — nothing here touches the file name).
 */
export function FilterBar({ model }: FilterBarProps) {
  useSyncExternalStore(model.subscribe, model.getVersion)

  const schema = model.schema ?? []
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({})
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  /** Inputs mirror the accepted state after a successful change. */
  const syncDrafts = (filters: readonly FilterSpec[]): void => {
    const next: Record<string, string> = {}
    for (const filter of filters) next[filter.column] = filter.predicate
    setDrafts(next)
  }

  const applyList = async (
    previous: readonly FilterSpec[],
    next: readonly FilterSpec[],
  ): Promise<void> => {
    if (pending) return
    setPending(true)
    setError(null)
    try {
      await model.setFilters(next)
      syncDrafts(next)
    } catch (cause) {
      const message = errorMessage(cause)
      try {
        // Restore the last accepted list: the failed refresh left the model
        // and provider holding the rejected list, and the contract's rule is
        // that a rejection leaves the previous filter state in effect.
        await model.setFilters(previous)
        syncDrafts(previous)
        setError(message)
      } catch (restoreCause) {
        setError(
          `${message} — restoring the previous filters also failed: ${errorMessage(restoreCause)}`,
        )
      }
    } finally {
      setPending(false)
    }
  }

  const applyDraft = (column: string): void => {
    void applyList(model.filters, replaceColumnFilter(model.filters, column, drafts[column] ?? ''))
  }

  const removeFilter = (column: string): void => {
    void applyList(
      model.filters,
      model.filters.filter((filter) => filter.column !== column),
    )
  }

  return (
    <section className="filter-bar" data-testid="filter-bar" aria-label="Filters">
      <h2 className="visually-hidden">Filters</h2>
      <p className="filter-hint" data-testid="filter-hint">
        Filters are SQL fragments applied to one column as <code>{'("column" <predicate>)'}</code> —
        e.g. <code>{'> 50000'}</code>, <code>{"= 'US'"}</code>, <code>IS NOT NULL</code>. Leave an
        input empty for no filter on that column.
      </p>
      <ul className="filter-columns" data-testid="filter-columns">
        {schema.map((column) => (
          <li key={column.name} className="filter-column" data-testid="filter-column">
            <label className="filter-label" htmlFor={filterInputId(column.name)}>
              {column.name}
            </label>
            <input
              id={filterInputId(column.name)}
              className="filter-input"
              data-testid="filter-input"
              data-col-name={column.name}
              type="text"
              spellCheck={false}
              autoComplete="off"
              placeholder="e.g. > 50000"
              value={drafts[column.name] ?? ''}
              disabled={pending}
              onChange={(event) => {
                const value = event.target.value
                setDrafts((previous) => ({ ...previous, [column.name]: value }))
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') applyDraft(column.name)
              }}
            />
            <button
              type="button"
              className="filter-apply"
              data-testid="filter-apply"
              data-col-name={column.name}
              disabled={pending}
              onClick={() => {
                applyDraft(column.name)
              }}
            >
              Apply
            </button>
          </li>
        ))}
      </ul>
      {model.filters.length > 0 ? (
        <ul className="filter-chips" data-testid="filter-chips">
          {model.filters.map((filter) => (
            <li
              key={`${filter.column}:${filter.predicate}`}
              className="filter-chip"
              data-testid="filter-chip"
              data-col-name={filter.column}
            >
              <code>{`${filter.column} ${filter.predicate}`}</code>
              <button
                type="button"
                className="filter-chip-remove"
                data-testid="filter-chip-remove"
                data-col-name={filter.column}
                aria-label={`Remove filter ${filter.column} ${filter.predicate}`}
                title={`Remove filter ${filter.column} ${filter.predicate}`}
                disabled={pending}
                onClick={() => {
                  removeFilter(filter.column)
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="filter-empty" data-testid="filter-empty">
          No active filters
        </p>
      )}
      {error !== null && (
        <p className="filter-error" role="alert" data-testid="filter-error">
          {error}
        </p>
      )}
    </section>
  )
}
