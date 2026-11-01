// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { FilterSpec, GridViewportModel } from '@assay/grid'
import { domId } from '../lib/dom-id'
import { engineErrorMessage } from '../edit/session'
import { replaceColumnFilter } from './query-state'
import { classifyColumnType, compileFilterInput, filterOperators } from './filter-builder'
import type { FilterColumnProfile, FilterOperatorId } from './filter-builder'

interface FilterBarProps {
  model: GridViewportModel
}

/** The honest fallback profile for a column the builder cannot classify. */
const OTHER_PROFILE: FilterColumnProfile = { kind: 'other', temporalKeyword: null }

function errorMessage(error: unknown): string {
  // UG-30: filter failures are framed once, single-line, and name the state
  // that survives (the previous filters) — never a raw multi-line diagnostic.
  return engineErrorMessage('filter', error)
}

/**
 * Injective, deterministic *identity* of the active filter list: `null` means
 * "no filters" (distinct from any non-empty list), otherwise the ordered
 * `[column, predicate]` pairs serialized as JSON. A `column:predicate` join
 * would collide if either field contained the delimiter, and chip keys already
 * rely on the same pair; order is part of identity because the model pushes the
 * list to the provider in order. Changing any predicate changes the string.
 */
function filterListSignature(filters: readonly FilterSpec[]): string | null {
  if (filters.length === 0) return null
  return JSON.stringify(filters.map((filter) => [filter.column, filter.predicate]))
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

/** Collision-safe DOM id for a column's builder value input (ux-4). */
export function filterBuilderValueId(columnName: string): string {
  return domId('filter-builder-value', columnName)
}

/** Collision-safe DOM id for an active filter row's predicate input (ug-18). */
export function filterActivePredicateId(columnName: string): string {
  return domId('filter-active-predicate', columnName)
}

/** A value-field placeholder that hints the column's expected shape. */
function placeholderFor(profile: FilterColumnProfile): string {
  switch (profile.kind) {
    case 'numeric':
      return 'e.g. 50000'
    case 'temporal':
      return profile.temporalKeyword === 'TIME' ? 'e.g. 12:00:00' : 'e.g. 2025-01-04'
    case 'string':
      return 'e.g. US'
    default:
      return ''
  }
}

/** The collapsed/expanded summary: the count plus the active column names. */
function summaryLabel(filters: readonly FilterSpec[]): string {
  if (filters.length === 0) return 'Filters'
  const columns = filters.map((filter) => filter.column).join(', ')
  return `Filters · ${String(filters.length)} active: ${columns}`
}

/** One active-filter chip: its column+predicate text plus a remove button. */
function FilterChip({
  filter,
  pending,
  onRemove,
}: {
  readonly filter: FilterSpec
  readonly pending: boolean
  readonly onRemove: (column: string) => void
}) {
  const label = `Remove filter ${filter.column} ${filter.predicate}`
  return (
    <li className="filter-chip" data-testid="filter-chip" data-col-name={filter.column}>
      <code>{`${filter.column} ${filter.predicate}`}</code>
      <button
        type="button"
        className="filter-chip-remove"
        data-testid="filter-chip-remove"
        data-col-name={filter.column}
        aria-label={label}
        title={label}
        disabled={pending}
        onClick={() => {
          onRemove(filter.column)
        }}
      >
        ×
      </button>
    </li>
  )
}

/**
 * Filter UI (ux-4, reworked by ug-18 / findings UG-16, UG-17): a
 * collapsed-by-default disclosure whose summary names the active filters
 * ("Filters · 2 active: salary, date") with the active chips (and their
 * remove buttons) beside the toggle, expanding to
 *
 * 1. **one compose row** — "Filter on: [column ▾] [operator ▾] [value]
 *    [Apply]" — instead of the old per-column builder wall (UG-16),
 * 2. **editable rows** for the active filters (column, predicate draft,
 *    Apply, Remove),
 * 3. the preserved **SQL-fragment escape hatch**, now behind its own labeled
 *    `SQL predicates` disclosure.
 *
 * Every accepted change goes through `GridViewportModel.setFilters` (the v1
 * `FilterSpec` grammar is unchanged): the compose row compiles its
 * operator+value to a column-qualified predicate fragment
 * (`filter-builder.ts`), the active rows and the escape hatch forward their
 * predicate, and the summary/chips are read from `model.filters` — so a
 * programmatic `setFilters` (the validation panel's "Show only failing rows"
 * bridge, or a profile top-k click) is reflected too.
 *
 * Error handling: invalid builder combinations are rejected **client-side**
 * with an inline, value-free message and never reach the engine. The escape
 * hatch keeps the m2-3 behavior: an invalid fragment rejects at the engine
 * while the model's refresh re-reads the filtered total; the rejection is
 * caught, the last accepted list is restored, and the engine's own message is
 * surfaced as a text-only alert (ADR 0007 spirit — predicate fragments and
 * engine errors are untrusted *content*, never markup; ADR 0025 — nothing
 * here touches the file name).
 */
export function FilterBar({ model }: FilterBarProps) {
  useSyncExternalStore(model.subscribe, model.getVersion)

  const schema = model.schema ?? []
  const [open, setOpen] = useState(false)
  // One predicate draft per column, shared by the active rows and the SQL
  // escape hatch (the app's established "apply this predicate to this column"
  // semantics). It mirrors the accepted list after every successful apply.
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({})
  // The compose row's selection: `null` = "not chosen yet", so the row falls
  // back to the first schema column and that column kind's default operator.
  const [composeColumn, setComposeColumn] = useState<string | null>(null)
  const [composeOperator, setComposeOperator] = useState<FilterOperatorId | null>(null)
  const [composeValue, setComposeValue] = useState('')
  const [composeError, setComposeError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const profiles = new Map(schema.map((column) => [column.name, classifyColumnType(column.type)]))

  // Derived compose selection: a column the schema no longer has (a renamed
  // column, a reloaded dataset) falls back to the first column, and an
  // operator that the selected column kind does not offer falls back to that
  // kind's default — the reset the contract asks for, without an effect that
  // could race a render.
  const selectedColumn = schema.find((column) => column.name === composeColumn) ?? schema[0]
  const selectedProfile =
    selectedColumn === undefined
      ? OTHER_PROFILE
      : (profiles.get(selectedColumn.name) ?? OTHER_PROFILE)
  const operators = filterOperators(selectedProfile.kind)
  const operator = operators.find((entry) => entry.id === composeOperator) ?? operators[0]
  const composeNeedsValue = operator?.needsValue ?? false

  // Filter *identity*, not just the active count (uxc-4): a programmatic
  // replacement at the same count — e.g. the validation panel's "Show only
  // failing rows" for rule B replacing rule A — must re-open a bar the user had
  // collapsed over the old predicate, or the predicate silently swaps under a
  // collapsed bar.
  //
  // The effect depends on the filter *list*, not only its derived signature, so
  // a same-identity re-set (`setFilters` with an equal-but-fresh list) still
  // re-runs it. That is what makes the latch load-bearing: on the re-run the
  // `collapsedRef` guard matches and keeps the bar collapsed. `collapsedRef` is
  // the user-collapse latch, bound to the signature the user collapsed under;
  // any different non-empty set — a same-count replacement included — overrides
  // it, and emptying retires it (the collapsed set no longer exists).
  const signature = filterListSignature(model.filters)
  const collapsedRef = useRef<string | null>(null)
  // Collapsing during an in-flight apply must latch the *incoming* set, not the
  // pre-apply one still on screen: that apply is about to replace it, so
  // latching the pre-apply signature would let the user's own edit force-open
  // over their deliberate collapse. This flag defers the latch until the
  // incoming signature lands (uxc-4 round 2, reviewer policy (i)).
  const latchIncomingRef = useRef(false)

  useEffect(() => {
    if (signature === null) {
      // Emptying the filters never force-opens. It also retires the latch
      // (the collapsed set no longer exists), so the next fresh filter
      // (empty → non-empty) auto-opens exactly as it did before uxc-4.
      collapsedRef.current = null
      latchIncomingRef.current = false
      return
    }
    if (latchIncomingRef.current) {
      // A collapse made mid-apply binds to the set that apply landed, so the
      // user's own edit re-firing this effect cannot re-open over it.
      latchIncomingRef.current = false
      collapsedRef.current = signature
      return
    }
    // A user collapse is honored only for the exact set it was made under: a
    // same-identity programmatic re-set re-runs this effect but matches the
    // latch and stays collapsed; a different non-empty set — same count
    // included — overrides it.
    if (collapsedRef.current === signature) return
    setOpen(true)
    collapsedRef.current = null
  }, [model.filters, signature])

  /** Inputs mirror the accepted state after a successful change. */
  const syncDrafts = (filters: readonly FilterSpec[]): void => {
    const next: Record<string, string> = {}
    for (const filter of filters) next[filter.column] = filter.predicate
    setDrafts(next)
  }

  /** Apply a filter list; `true` when the model accepted it (ug-18 compose). */
  const applyList = async (
    previous: readonly FilterSpec[],
    next: readonly FilterSpec[],
  ): Promise<boolean> => {
    if (pending) return false
    setPending(true)
    setError(null)
    try {
      await model.setFilters(next)
      syncDrafts(next)
      return true
    } catch (cause) {
      const message = errorMessage(cause)
      try {
        // Restore the last accepted list: the failed refresh left the model
        // and provider holding the rejected list, and the contract's rule is
        // that a rejection leaves the previous filter state in effect.
        await model.setFilters(previous)
        syncDrafts(previous)
        setError(message)
      } catch {
        // Double failure: the apply failed AND the restore failed. This branch
        // must NOT inherit the single-failure framing — that copy asserts the
        // previous filters are still in effect, which is exactly what could
        // not be restored, so the state may be unknown or partially changed.
        // Say only what is known (both calls failed), emit no values and no
        // newline, and point at the two ways back.
        setError(
          'The filter could not be applied and the previous filters could not be restored. ' +
            'Re-apply a filter or reopen the dataset if the grid looks wrong.',
        )
      }
      return false
    } finally {
      setPending(false)
    }
  }

  const applyCompose = (): void => {
    if (selectedColumn === undefined || operator === undefined || pending) return
    const result = compileFilterInput(selectedProfile, operator.id, composeValue)
    if (!result.ok) {
      // Client-side rejection: one inline line, no engine call (ux-4).
      setComposeError(result.message)
      return
    }
    setComposeError(null)
    const column = selectedColumn.name
    void applyList(
      model.filters,
      replaceColumnFilter(model.filters, column, result.predicate),
    ).then((accepted) => {
      // Clear only the value: the column/operator stay selected for the next
      // filter on the same column (ug-18 contract).
      if (accepted) setComposeValue('')
    })
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

  const activeCount = model.filters.length

  return (
    <section className="filter-bar" data-testid="filter-bar" aria-label="Filters">
      <h2 className="visually-hidden">Filters</h2>
      <div className="filter-header">
        <button
          type="button"
          className="filter-toggle"
          data-testid="filter-toggle"
          aria-expanded={open}
          aria-controls="filter-body"
          onClick={() => {
            const next = !open
            setOpen(next)
            if (next) {
              // Opening clears the latch so a later programmatic change can
              // re-open (uxc-4).
              collapsedRef.current = null
              latchIncomingRef.current = false
            } else if (pending) {
              // Collapsing mid-apply: the visible signature is about to be
              // replaced, so bind the latch to the incoming set instead —
              // otherwise the user's own edit would force-open over this
              // deliberate collapse (uxc-4 round 2, reviewer policy (i)).
              collapsedRef.current = null
              latchIncomingRef.current = true
            } else {
              // Collapsing latches onto the current filter set.
              collapsedRef.current = signature
              latchIncomingRef.current = false
            }
          }}
        >
          {summaryLabel(model.filters)}
        </button>
        {/*
         * UG-17: the collapsed bar is the recommended posture, so the chips
         * (and their remove buttons) live BESIDE the toggle, never inside it —
         * a button may not contain interactive descendants. The expanded body
         * keeps its own detailed chip list; the two are mutually exclusive so
         * a chip is never rendered twice.
         */}
        {!open && activeCount > 0 && (
          <ul className="filter-chips filter-chips-header" data-testid="filter-chips-header">
            {model.filters.map((filter) => (
              <FilterChip
                key={`${filter.column}:${filter.predicate}`}
                filter={filter}
                pending={pending}
                onRemove={removeFilter}
              />
            ))}
          </ul>
        )}
      </div>
      {open && (
        <div id="filter-body" className="filter-body" data-testid="filter-body">
          {/* UG-16: exactly ONE compose row replaces the per-column wall. */}
          {selectedColumn !== undefined && (
            <div className="filter-compose" data-testid="filter-compose">
              <label className="filter-compose-label" htmlFor="filter-compose-column">
                Filter on:
              </label>
              <select
                id="filter-compose-column"
                className="filter-compose-column"
                data-testid="filter-compose-column"
                value={selectedColumn.name}
                disabled={pending}
                onChange={(event) => {
                  // A different column kind gets that kind's default operator
                  // and a fresh value (the shapes differ per kind).
                  setComposeColumn(event.target.value)
                  setComposeOperator(null)
                  setComposeValue('')
                  setComposeError(null)
                }}
              >
                {schema.map((column) => (
                  <option key={column.name} value={column.name}>
                    {column.name}
                  </option>
                ))}
              </select>
              <select
                className="filter-compose-operator"
                data-testid="filter-compose-operator"
                aria-label="Filter operator"
                value={operator?.id ?? ''}
                disabled={pending}
                onChange={(event) => {
                  setComposeOperator(event.target.value as FilterOperatorId)
                  setComposeError(null)
                }}
              >
                {operators.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </select>
              {composeNeedsValue && (
                <input
                  id={filterBuilderValueId(selectedColumn.name)}
                  className="filter-compose-value"
                  data-testid="filter-compose-value"
                  aria-label="Filter value"
                  type="text"
                  spellCheck={false}
                  autoComplete="off"
                  placeholder={placeholderFor(selectedProfile)}
                  value={composeValue}
                  disabled={pending}
                  onChange={(event) => {
                    setComposeValue(event.target.value)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') applyCompose()
                  }}
                />
              )}
              <button
                type="button"
                className="filter-compose-apply"
                data-testid="filter-compose-apply"
                disabled={pending}
                onClick={applyCompose}
              >
                Apply
              </button>
              {composeError !== null && (
                <p
                  className="filter-builder-error"
                  role="alert"
                  data-testid="filter-builder-error"
                  data-col-name={selectedColumn.name}
                >
                  {composeError}
                </p>
              )}
            </div>
          )}
          {/* Editable rows for the active filters (the required surface). */}
          {activeCount > 0 && (
            <ul className="filter-active-rows" data-testid="filter-active-rows">
              {model.filters.map((filter) => (
                <li
                  key={`${filter.column}:${filter.predicate}`}
                  className="filter-active-row"
                  data-testid="filter-active-row"
                  data-col-name={filter.column}
                >
                  <label className="filter-label" htmlFor={filterActivePredicateId(filter.column)}>
                    {filter.column}
                  </label>
                  <input
                    id={filterActivePredicateId(filter.column)}
                    className="filter-input filter-active-input"
                    data-testid="filter-active-predicate"
                    data-col-name={filter.column}
                    type="text"
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="e.g. > 50000"
                    value={drafts[filter.column] ?? filter.predicate}
                    disabled={pending}
                    onChange={(event) => {
                      const value = event.target.value
                      setDrafts((previous) => ({ ...previous, [filter.column]: value }))
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') applyDraft(filter.column)
                    }}
                  />
                  <button
                    type="button"
                    className="filter-apply"
                    data-testid="filter-active-apply"
                    data-col-name={filter.column}
                    disabled={pending}
                    onClick={() => {
                      applyDraft(filter.column)
                    }}
                  >
                    Apply
                  </button>
                  <button
                    type="button"
                    className="filter-active-remove"
                    data-testid="filter-active-remove"
                    data-col-name={filter.column}
                    aria-label={`Remove filter ${filter.column} ${filter.predicate}`}
                    title={`Remove filter ${filter.column} ${filter.predicate}`}
                    disabled={pending}
                    onClick={() => {
                      removeFilter(filter.column)
                    }}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          {/* UG-16: the per-column SQL-fragment escape hatch, own disclosure. */}
          <details className="filter-sql-disclosure" data-testid="filter-sql-disclosure">
            <summary className="filter-sql-summary">SQL predicates</summary>
            <p className="filter-hint" data-testid="filter-hint">
              Escape hatch for a raw SQL predicate on one column. Fragments are applied as{' '}
              <code>{'("column" <predicate>)'}</code> — e.g. <code>{'> 50000'}</code>,{' '}
              <code>{"= 'US'"}</code>, <code>IS NOT NULL</code>. Leave an input empty for no filter
              on that column.
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
          </details>
          {model.filters.length > 0 ? (
            <ul className="filter-chips" data-testid="filter-chips">
              {model.filters.map((filter) => (
                <FilterChip
                  key={`${filter.column}:${filter.predicate}`}
                  filter={filter}
                  pending={pending}
                  onRemove={removeFilter}
                />
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
        </div>
      )}
    </section>
  )
}
