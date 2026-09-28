// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EngineTableHandle } from '@assay/engine-duckdb'
import { App } from './App'
import type { ArrowTableLike } from './grid/provider'

/**
 * m4-0 pin for the m3-5 compose-failure alert render (the M3 reviewer
 * carry-over: the path is unreachable on well-formed fixtures, so no e2e
 * could exercise it — a component test must).
 *
 * What is rendered: the REAL app composition root. Only the environment
 * boundaries are faked — the file picker and the engine client (a few
 * resolved promises, DESCRIBE-shaped schema) — plus the two engine-calling
 * panels orthogonal to the alert path (SqlPanel, ProfilePanel; both are
 * e2e-pinned elsewhere and would otherwise need query/profile fakes).
 * SchemaPanel, FilterBar, DataGrid, RecordInspector and the pure composer
 * chain (`composeNestedAction`) all run for real, so the test drives the
 * actual click surface → composer → state → render path.
 *
 * The degenerate schema: a fixed-size array column (`VARCHAR[3]`). The
 * schema tree honestly offers Explode on every LIST-kinded column root, but
 * the composer rejects fixed-size arrays (pinned in nested-compose.test.ts)
 * — exactly the "UI gating cannot fully rule out" failure class the alert
 * exists for. The pin asserts:
 *
 * 1. failure → an element with `role="alert"` whose text is the composer's
 *    exact reason — never a silent no-op;
 * 2. a subsequent successful action (flatten the well-formed struct) clears
 *    the prior error — the alert disappears;
 * 3. a fresh failure renders a fresh alert (the clear was a real state
 *    change, not a stuck render).
 *
 * Mutation-observability: killing the `setActionError(composed.reason)`
 * line fails (1); removing `role="alert"` fails (1) via the role query;
 * killing the success-path `setActionError(null)` fails (2); replacing the
 * alert paragraph with a static element fails (2)/(3).
 *
 * Environment scoping: the root vitest config routes `apps/web/src/**` tests
 * into a dedicated `web` project with `environment: 'happy-dom'` (f-7), so the
 * DOM environment is selected by path and no per-file opt-in can be forgotten.
 * Text-only assertions on `textContent` (ADR 0007 spirit: values render as
 * text, nothing here executes or logs them).
 */

/** Fake open result: the engine's opaque handle shape (engine-generated id). */
const FAKE_HANDLE: EngineTableHandle = { kind: 'table', id: 't1' }

/**
 * DESCRIBE-shaped fake schema (DuckDB type strings, as the engine reports
 * them): `meta` is the well-formed flatten target, `tags` the degenerate
 * fixed-size array whose explode the composer must reject.
 */
const FAKE_SCHEMA: readonly { name: string; type: string }[] = [
  { name: 'id', type: 'BIGINT' },
  { name: 'meta', type: 'STRUCT(src VARCHAR, ver BIGINT)' },
  { name: 'tags', type: 'VARCHAR[3]' },
]

/** One-row fake Arrow batch, structurally shaped for the provider seam. */
function fakeBatch(): ArrowTableLike {
  const columns = [{ get: () => 1 }, { get: () => 'x' }, { get: () => null }]
  return {
    numRows: 1,
    numCols: columns.length,
    getChildAt: (index: number) => columns[index] ?? null,
  }
}

vi.mock('@assay/data-sources/browser', () => ({
  // The picker resolves to a fake source; the File is never read here (the
  // faked engine client ignores it) — no dataset bytes, no file names in
  // any assertion (ADR 0025 posture, test-only data).
  pickDataFile: async (): Promise<{ source: { getFile: () => Promise<File> } }> => ({
    source: { getFile: async () => new File(['id\n1\n'], 'alert-pin.jsonl') },
  }),
}))

vi.mock('./lib/engine', () => ({
  engineClient: {
    open: async () => FAKE_HANDLE,
    schema: async () => FAKE_SCHEMA,
    rowCount: async () => 1,
    fetchRange: async () => ({ batch: fakeBatch(), hasMore: false }),
  },
}))

vi.mock('./sql/SqlPanel', () => ({ SqlPanel: () => null }))
vi.mock('./profile/ProfilePanel', () => ({ ProfilePanel: () => null }))

afterEach(cleanup)

describe('nested-action compose-failure alert (m4-0)', () => {
  it('surfaces the composer reason as role="alert", clears it on success, re-renders on a new failure', async () => {
    render(<App />)

    // Open through the real app flow (idle → ready): click, then let the
    // async open chain settle inside act and wait for the ready-phase UI.
    await act(async () => {
      fireEvent.click(screen.getByTestId('open-button'))
    })
    await screen.findByTestId('schema-section')

    // 1. Failure: exploding the fixed-size array composes to nothing — the
    // composer's exact reason must be visible as an alert (never a no-op).
    // (Clicks target the schema tree; the real grid header offers the same
    // action for the same column, so the query is scoped to one surface.)
    const schemaPanel = within(screen.getByTestId('schema-panel'))
    await act(async () => {
      fireEvent.click(schemaPanel.getByRole('button', { name: 'Explode list column tags' }))
    })
    expect(screen.getByRole('alert').textContent).toBe(
      'column "tags" is a fixed-size array ([3]); DuckDB UNNEST cannot explode it',
    )

    // 2. Success: flattening the well-formed struct composes and dispatches;
    // the prior error is cleared — the alert disappears.
    await act(async () => {
      fireEvent.click(schemaPanel.getByRole('button', { name: 'Flatten struct column meta' }))
    })
    expect(screen.queryByRole('alert')).toBeNull()

    // 3. A fresh failure renders a fresh alert — the clear was real state.
    await act(async () => {
      fireEvent.click(schemaPanel.getByRole('button', { name: 'Explode list column tags' }))
    })
    expect(screen.getByRole('alert').textContent).toBe(
      'column "tags" is a fixed-size array ([3]); DuckDB UNNEST cannot explode it',
    )
  })
})
