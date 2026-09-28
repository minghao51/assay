// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from 'react'
import type {
  EngineCategoricalTopKEntry,
  EngineNumericColumnStats,
  EngineProfileColumn,
  EngineTableHandle,
} from '@assay/engine-duckdb'
import { engineClient } from '../lib/engine'
import { runGuarded } from '../sql/guarded-run'
import { RunGuard } from '../sql/run-guard'
import { formatStat, quantileStripLabel, topKChartLabel } from './format-stats'
import { quantileStrip } from './quantile-strip'
import type { ProfileData, ProfileState } from './profile-state'
import { reduceProfileState } from './profile-state'
import { scaleTopKBars } from './topk-bars'

/**
 * Profile panel (m2-6): per-column statistics of the opened table from the
 * engine's `profile()` op (m2-5) — null/distinct counts for every column,
 * numeric stats + quantiles for `numeric` columns, categorical top-k for
 * `categorical` ones, and a graceful degraded display (no payloads) for
 * `other` columns.
 *
 * Design decisions:
 *
 * - **Trigger + running state.** `profile()` is one engine op on the single
 *   FIFO OpChannel, shared with grid windows and SQL queries, and can take
 *   seconds to tens of seconds on large files — so the run is explicit
 *   (user-triggered button) and the running state is a polite live region
 *   (`role="status"`) that says what is happening and why it may take a
 *   while (including the queued-behind-a-busy-engine case).
 * - **Guarded delivery (two layers, stated honestly).** Today's operative
 *   mechanism is structural: App's phase machine unmounts the whole panel
 *   composition during `ready → opening → ready`, so a re-open destroys
 *   this component instance together with its in-flight promise tail — a
 *   late profile of a *previous* table has nothing to render into. The
 *   generation guard (`RunGuard` + `runGuarded` — the SQL pane's, imported
 *   not forked) plus the handle-change effect below are the defensive
 *   second layer: they are inert while the remount exists and become
 *   operative only if the panel is ever kept mounted across re-opens (a
 *   plausible refactor to avoid the grid remount). The re-open e2e in
 *   tests/e2e/profile-panel.spec.ts pins the property under both
 *   structures. Honest limitation, identical to the SQL pane's cancel: the
 *   engine has no op interrupt, so the abandoned profile still occupies the
 *   FIFO until it completes.
 * - **Charts are dependency-free SVG** built from Node-tested geometry
 *   modules: categorical top-k → horizontal bars scaled to the largest
 *   count (`topk-bars.ts`); numeric → a *quantile distribution* strip over
 *   the exact m2-5 boundaries min→p50→p90→p95→p99→max (`quantile-strip.ts`
 *   — the engine delivers quantiles, not row samples, so a true histogram
 *   is not honestly drawable and this is labeled as what it is).
 * - **A11y (definition-of-done).** Charts carry `role="img"` with a complete
 *   text alternative as the accessible name (every bar/boundary value), plus
 *   per-bar `<title>`s and visible text labels; stats are definition lists;
 *   errors are `role="alert"` and retryable. All rendering is React text
 *   interpolation — profile outputs and engine errors are untrusted *content*
 *   (ADR 0007 spirit), and nothing about the data or file name is logged
 *   (ADR 0025; the panel never receives the file name).
 */

interface ProfilePanelProps {
  /** Handle of the currently opened table (re-opens invalidate in-flight runs). */
  readonly handle: EngineTableHandle
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Numeric stat rows in display order: label, value, per-stat test id. */
const NUMERIC_STAT_ROWS: ReadonlyArray<{
  label: string
  value: (stats: EngineNumericColumnStats) => number | null
  testId: string
}> = [
  { label: 'Min', value: (stats) => stats.min, testId: 'profile-stat-min' },
  { label: 'Max', value: (stats) => stats.max, testId: 'profile-stat-max' },
  { label: 'Mean', value: (stats) => stats.mean, testId: 'profile-stat-mean' },
  { label: 'Stddev', value: (stats) => stats.stddev, testId: 'profile-stat-stddev' },
  { label: 'p50', value: (stats) => stats.quantiles.p50, testId: 'profile-stat-p50' },
  { label: 'p90', value: (stats) => stats.quantiles.p90, testId: 'profile-stat-p90' },
  { label: 'p95', value: (stats) => stats.quantiles.p95, testId: 'profile-stat-p95' },
  { label: 'p99', value: (stats) => stats.quantiles.p99, testId: 'profile-stat-p99' },
]

/** Numeric stats as a definition list — nulls render honestly as '—'. */
function NumericStats({ stats }: { stats: EngineNumericColumnStats }) {
  return (
    <>
      {NUMERIC_STAT_ROWS.map((row) => (
        <div className="profile-stat" key={row.label} data-testid="profile-stat-row">
          <dt>{row.label}</dt>
          <dd data-testid={row.testId}>{formatStat(row.value(stats))}</dd>
        </div>
      ))}
    </>
  )
}

/**
 * Quantile distribution strip (numeric columns): proportional segments over
 * the exact engine quantile boundaries, boundary ticks as visible text under
 * the strip, `role="img"` with the full text alternative as its name.
 */
function QuantileStripChart({ name, stats }: { name: string; stats: EngineNumericColumnStats }) {
  const strip = quantileStrip(stats)
  if (strip.segments.length === 0) {
    return (
      <p className="profile-strip-empty" data-testid="profile-strip-empty" data-col-name={name}>
        No non-null values — no quantile distribution to draw.
      </p>
    )
  }
  const ticks: ReadonlyArray<{ tick: string; value: number | null }> = [
    { tick: 'min', value: stats.min },
    { tick: 'p50', value: stats.quantiles.p50 },
    { tick: 'p90', value: stats.quantiles.p90 },
    { tick: 'p95', value: stats.quantiles.p95 },
    { tick: 'p99', value: stats.quantiles.p99 },
    { tick: 'max', value: stats.max },
  ]
  return (
    <figure className="profile-strip" data-testid="profile-strip" data-col-name={name}>
      <svg
        className="profile-strip-svg"
        role="img"
        aria-label={quantileStripLabel(name, stats)}
        viewBox="0 0 100 10"
        preserveAspectRatio="none"
        data-testid="profile-strip-svg"
      >
        {strip.segments.map((segment) => (
          <rect
            key={segment.name}
            className="profile-strip-segment"
            data-testid="profile-strip-segment"
            data-seg-name={segment.name}
            x={segment.fromFraction * 100}
            y={0}
            width={(segment.toFraction - segment.fromFraction) * 100}
            height={10}
          >
            <title>{`${segment.name}: ${formatStat(segment.from)} – ${formatStat(segment.to)}`}</title>
          </rect>
        ))}
      </svg>
      <figcaption className="profile-strip-ticks" data-testid="profile-strip-ticks">
        {ticks.map(({ tick, value }) => (
          <span
            key={tick}
            className="profile-strip-tick"
            data-testid="profile-strip-tick"
            data-tick={tick}
          >
            <span className="profile-strip-tick-name">{tick}</span> {formatStat(value)}
          </span>
        ))}
      </figcaption>
    </figure>
  )
}

/**
 * Categorical top-k chart: one horizontal bar per entry (value label, bar
 * scaled to the largest count, count), wrapped in a `role="img"` container
 * whose accessible name is the complete text alternative (every value and
 * count) — the per-bar `<title>`s and visible text restate the same data.
 */
function TopKChart({
  name,
  topK,
  distinctCount,
}: {
  name: string
  topK: readonly EngineCategoricalTopKEntry[]
  distinctCount: number
}) {
  const bars = scaleTopKBars(topK)
  if (bars.length === 0) {
    return (
      <p className="profile-topk-empty" data-testid="profile-topk-empty" data-col-name={name}>
        No non-null values — nothing to rank.
      </p>
    )
  }
  return (
    <div
      className="profile-topk"
      data-testid="profile-topk"
      data-col-name={name}
      role="img"
      aria-label={topKChartLabel(name, topK, distinctCount)}
    >
      <p className="profile-topk-caption" data-testid="profile-topk-caption">
        Top {bars.length} of {distinctCount} distinct non-null values
      </p>
      <ul className="profile-topk-list" data-testid="profile-topk-list">
        {bars.map((bar) => (
          <li
            key={bar.value}
            className="profile-topk-row"
            data-testid="profile-topk-row"
            data-topk-value={bar.value}
          >
            <span className="profile-topk-value" data-testid="profile-topk-value">
              {bar.value}
            </span>
            <span className="profile-topk-track" aria-hidden="true">
              <svg className="profile-topk-bar-svg" viewBox="0 0 100 10" preserveAspectRatio="none">
                <rect
                  className="profile-topk-bar"
                  data-testid="profile-topk-bar"
                  data-bar-fraction={bar.fraction}
                  x={0}
                  y={0}
                  width={bar.fraction * 100}
                  height={10}
                >
                  <title>{`${bar.value}: ${String(bar.count)}`}</title>
                </rect>
              </svg>
            </span>
            <span className="profile-topk-count" data-testid="profile-topk-count">
              {bar.count}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** One profiled column: identity, kind badge, shared counts, kind-specific display. */
function ProfileColumnView({ column }: { column: EngineProfileColumn }) {
  return (
    <li
      className="profile-column"
      data-testid="profile-column"
      data-col-name={column.name}
      data-col-kind={column.kind}
    >
      <span className="profile-col-name" data-testid="profile-col-name">
        {column.name}
      </span>
      <span className="profile-badge" data-testid="profile-col-type">
        {column.type}
      </span>
      <span className="profile-badge profile-badge-kind" data-testid="profile-col-kind">
        {column.kind}
      </span>
      <dl className="profile-stats" data-testid="profile-stats">
        <div className="profile-stat" data-testid="profile-stat-row">
          <dt>Nulls</dt>
          <dd data-testid="profile-null-count">{column.nullCount}</dd>
        </div>
        <div className="profile-stat" data-testid="profile-stat-row">
          <dt>Distinct</dt>
          <dd data-testid="profile-distinct-count">{column.distinctCount}</dd>
        </div>
        {column.numeric !== undefined && <NumericStats stats={column.numeric} />}
      </dl>
      {/* `other` columns stop here by design: the degraded fields only. */}
      {column.numeric !== undefined && (
        <QuantileStripChart name={column.name} stats={column.numeric} />
      )}
      {column.categorical !== undefined && (
        <TopKChart
          name={column.name}
          topK={column.categorical.topK}
          distinctCount={column.distinctCount}
        />
      )}
    </li>
  )
}

function ProfileTable({ profile }: { profile: ProfileData }) {
  return (
    <>
      <p className="profile-rowcount" data-testid="profile-rowcount">
        <span data-testid="profile-rowcount-value">{profile.rowCount}</span> rows ·{' '}
        {profile.columns.length} columns
      </p>
      <ul className="profile-columns" data-testid="profile-columns">
        {profile.columns.map((column) => (
          <ProfileColumnView key={column.name} column={column} />
        ))}
      </ul>
    </>
  )
}

/**
 * Disclosure panel, open by default (consistent with the schema panel); the
 * profile itself only runs when the user triggers it — it is the one op that
 * can take tens of seconds on multi-GB files.
 */
export function ProfilePanel({ handle }: ProfilePanelProps) {
  const [open, setOpen] = useState(true)
  const [state, setState] = useState<ProfileState>({ kind: 'idle' })
  const guard = useRef(new RunGuard())
  const lastTableId = useRef<string | null>(null)

  /**
   * Defensive second layer only: today the App phase machine unmounts this
   * panel during `ready → opening → ready`, so while a profile is in flight
   * this effect cannot fire — the remount is what actually protects (see
   * the "Guarded delivery" note above). Should the panel ever be kept
   * mounted across a re-open, a handle change invalidates the in-flight
   * run's generation token (the guard then discards the previous table's
   * late result when it arrives) and drops any stale display. The abandoned
   * op still occupies the engine FIFO until it completes — same honest
   * UI-level-abandonment semantics as the SQL pane's cancel (no op
   * interrupt exists; m2-7 territory).
   */
  useEffect(() => {
    if (lastTableId.current === handle.id) return
    lastTableId.current = handle.id
    guard.current.invalidate()
    setState({ kind: 'idle' })
  }, [handle.id])

  const runProfile = (): void => {
    if (state.kind === 'running') return
    setState(reduceProfileState(state, { type: 'started' }))
    runGuarded(guard.current, engineClient.profile(handle), {
      onResult: (profile) => {
        setState((current) => reduceProfileState(current, { type: 'succeeded', profile }))
      },
      onError: (cause: unknown) => {
        setState((current) =>
          reduceProfileState(current, { type: 'failed', message: errorMessage(cause) }),
        )
      },
    })
  }

  return (
    <section
      className="profile"
      data-testid="profile-section"
      aria-label="Column profile"
      data-state={state.kind}
    >
      <h2 className="visually-hidden">Profile</h2>
      <button
        type="button"
        className="profile-panel-toggle"
        data-testid="profile-toggle"
        aria-expanded={open}
        aria-controls="profile-panel"
        onClick={() => {
          setOpen((previous) => !previous)
        }}
      >
        <span className="schema-struct-marker" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        Profile
      </button>
      {open && (
        /* q-3 (pt0-4 residue): the outer `<section aria-label="Column profile">`
           is the panel landmark; this inner results region must have a distinct
           name or axe `landmark-unique` fires (two regions with the same
           role/name). */
        <div
          id="profile-panel"
          className="profile-panel"
          data-testid="profile-panel"
          role="region"
          aria-label="Column profile results"
        >
          {state.kind === 'idle' && (
            <>
              <p className="profile-hint" data-testid="profile-hint">
                Compute per-column statistics for table{' '}
                <code data-testid="profile-table-id">{handle.id}</code> — null and distinct counts,
                numeric stats with quantiles, categorical top-k. The profile runs on the engine and
                shares its queue with grid windows and SQL queries, so it can take a while on large
                files.
              </p>
              <button
                type="button"
                className="profile-run"
                data-testid="profile-run"
                onClick={runProfile}
              >
                Compute profile
              </button>
            </>
          )}
          {state.kind === 'running' && (
            <p className="profile-running" role="status" data-testid="profile-running">
              Profiling table <code>{handle.id}</code>… the profile may be queued behind an
              in-flight engine operation and scans the whole file — this can take seconds on large
              tables.
            </p>
          )}
          {state.kind === 'error' && (
            <>
              <p className="profile-error" role="alert" data-testid="profile-error">
                {state.message}
              </p>
              <button
                type="button"
                className="profile-run"
                data-testid="profile-retry"
                onClick={runProfile}
              >
                Retry
              </button>
            </>
          )}
          {state.kind === 'done' && <ProfileTable profile={state.profile} />}
        </div>
      )}
    </section>
  )
}
