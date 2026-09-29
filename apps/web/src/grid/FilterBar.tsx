// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { FilterSpec, GridViewportModel } from '@assay/grid'
import { domId } from '../lib/dom-id'
import { replaceColumnFilter } from './query-state'
import {
  classifyColumnType,
  compileFilterInput,
  defaultOperatorForKind,
  filterOperators,
} from './filter-builder'
import type { FilterColumnProfile, FilterOperatorId } from './filter-builder'

interface FilterBarProps {
  model: GridViewportModel
}

/** Local per-column builder draft (an operator id plus the raw value). */
interface BuilderDraft {
  readonly operator: FilterOperatorId
  readonly value: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

/**
 * Filter UI (ux-4, superseding the m2-3 fragment-only editor): a
 * collapsed-by-default disclosure whose summary counts the active filters
 * ("Filters · 2 active"), expanding to a **type-aware operator/value builder**
 * per column plus the preserved **SQL-fragment escape hatch**.
 *
 * Every accepted change goes through `GridViewportModel.setFilters` (the v1
 * `FilterSpec` grammar is unchanged): the builder compiles its operator+value
 * to a column-qualified predicate fragment (`filter-builder.ts`), the escape
 * hatch forwards the raw fragment, and the chips/active count are read from
 * `model.filters` — so a programmatic `setFilters` (the validation panel's
 * "Show only failing rows" bridge) is reflected too.
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
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({})
  const [builderDrafts, setBuilderDrafts] = useState<Readonly<Record<string, BuilderDraft>>>({})
  const [builderErrors, setBuilderErrors] = useState<Readonly<Record<string, string | undefined>>>(
    {},
  )
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const profiles = new Map(schema.map((column) => [column.name, classifyColumnType(column.type)]))

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

  const draftFor = (columnName: string, profile: FilterColumnProfile): BuilderDraft =>
    builderDrafts[columnName] ?? {
      operator: defaultOperatorForKind(profile.kind),
      value: '',
    }

  const setBuilderDraft = (columnName: string, patch: Partial<BuilderDraft>): void => {
    const profile = profiles.get(columnName)
    if (profile === undefined) return
    setBuilderDrafts((previous) => ({
      ...previous,
      [columnName]: { ...draftFor(columnName, profile), ...patch },
    }))
  }

  const applyBuilder = (column: string): void => {
    const profile = profiles.get(column)
    if (profile === undefined || pending) return
    const draft = draftFor(column, profile)
    const result = compileFilterInput(profile, draft.operator, draft.value)
    if (!result.ok) {
      setBuilderErrors((previous) => ({ ...previous, [column]: result.message }))
      return
    }
    setBuilderErrors((previous) => ({ ...previous, [column]: undefined }))
    void applyList(model.filters, replaceColumnFilter(model.filters, column, result.predicate))
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
        {activeCount > 0 ? `Filters · ${String(activeCount)} active` : 'Filters'}
      </button>
      {open && (
        <div id="filter-body" className="filter-body" data-testid="filter-body">
          <ul className="filter-builder" data-testid="filter-builder">
            {schema.map((column) => {
              const profile = profiles.get(column.name) ?? {
                kind: 'other' as const,
                temporalKeyword: null,
              }
              const draft = draftFor(column.name, profile)
              const operators = filterOperators(profile.kind)
              const operator =
                operators.find((entry) => entry.id === draft.operator) ?? operators[0]
              const needsValue = operator?.needsValue ?? false
              const message = builderErrors[column.name]
              return (
                <li
                  key={column.name}
                  className="filter-builder-column"
                  data-testid="filter-builder-column"
                  data-col-name={column.name}
                >
                  <label
                    className="filter-label"
                    htmlFor={needsValue ? filterBuilderValueId(column.name) : undefined}
                  >
                    {column.name}
                  </label>
                  <select
                    className="filter-builder-operator"
                    data-testid="filter-builder-operator"
                    data-col-name={column.name}
                    aria-label={`Operator for ${column.name}`}
                    value={draft.operator}
                    disabled={pending}
                    onChange={(event) => {
                      setBuilderDraft(column.name, {
                        operator: event.target.value as FilterOperatorId,
                      })
                    }}
                  >
                    {operators.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.label}
                      </option>
                    ))}
                  </select>
                  {needsValue && (
                    <input
                      id={filterBuilderValueId(column.name)}
                      className="filter-builder-value"
                      data-testid="filter-builder-value"
                      data-col-name={column.name}
                      type="text"
                      spellCheck={false}
                      autoComplete="off"
                      placeholder={placeholderFor(profile)}
                      value={draft.value}
                      disabled={pending}
                      onChange={(event) => {
                        setBuilderDraft(column.name, { value: event.target.value })
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') applyBuilder(column.name)
                      }}
                    />
                  )}
                  <button
                    type="button"
                    className="filter-builder-apply"
                    data-testid="filter-builder-apply"
                    data-col-name={column.name}
                    disabled={pending}
                    onClick={() => {
                      applyBuilder(column.name)
                    }}
                  >
                    Apply
                  </button>
                  {message !== undefined && (
                    <p
                      className="filter-builder-error"
                      role="alert"
                      data-testid="filter-builder-error"
                      data-col-name={column.name}
                    >
                      {message}
                    </p>
                  )}
                </li>
              )
            })}
          </ul>
          <p className="filter-hint" data-testid="filter-hint">
            SQL predicate escape hatch. Fragments are applied to one column as{' '}
            <code>{'("column" <predicate>)'}</code> — e.g. <code>{'> 50000'}</code>,{' '}
            <code>{"= 'US'"}</code>, <code>IS NOT NULL</code>. Leave an input empty for no filter on
            that column.
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
        </div>
      )}
    </section>
  )
}
