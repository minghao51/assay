// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  EngineTableHandle,
  PipelineRunInput,
  PipelineRunOptions,
  PipelineRunResult,
} from '@assay/engine-duckdb'
import { PipelineRunError, PipelineRunRefusalError } from '@assay/engine-duckdb'
import { App } from './App'
import { usePipelineSession } from './pipeline/usePipelineSession'
import type { ArrowTableLike } from './grid/provider'
import type { DatasetSession } from './sessions/session-reset'

/**
 * p-5 App-level integration pins for the pipeline panel, driven through the
 * REAL composition root with only the environment boundaries faked (the
 * `App.test.tsx` posture): the picker (a File queue — every pick gesture,
 * dataset / pipeline / source, pops one entry), the engine client (open/
 * schema/rowCount/fetchRange for the dataset session + a DEFERRED
 * `runPipeline` the tests resolve or reject to simulate the runner), and
 * SqlPanel (replaced by a recording stub so the pipeline surface renders
 * without an engine). parsePipeline/validatePipeline/
 * compilePipeline run FOR REAL — the honest empty/error states are exercised
 * against the real p-1/p-2 surfaces.
 *
 * What is pinned here:
 *
 * 1. the provisional placement facts (section present in the ready frame;
 *    zero state; the f-1 session reset drops pipeline state on re-open);
 * 2. the honest error states: located parse errors and DAG/compile
 *    refusals render as alerts, nothing executed;
 * 3. the inspect list: topological order, kinds, relations, output flags,
 *    source pending/bound states (C2 — never guessed);
 * 4. the run discipline: unbound-source refusal collects ALL missing
 *    sources and calls the engine zero times; the Run control is disabled
 *    (serialized) while a run is in flight — AND the in-hook in-flight
 *    check is pinned directly (a second run() driven while in flight is a
 *    no-op: jsdom clicks bypass the disabled control); live per-node
 *    status; the completed state's row counts; the typed canceled outcome
 *    (named partial + next node, boundary disclosure); the value-free
 *    failed state naming the failing node — with the NEGATIVE sweep: the
 *    settled failed/canceled surfaces carry neither the picked source file
 *    name nor any dataset text (a mutant embedding picked names into the
 *    failure `message` must fail here);
 * 5. outputs → the grid-native preview (p2-6): "Preview output" opens the
 *    materialized relation through the p2-1 handle op, driving the EXISTING
 *    grid model/schema surfaces (never a SQL-result detour);
 * 6. privacy: picked file names never render (ADR 0025); a rejecting
 *    source pick degrades to the typed bind-failed alert (the open path's
 *    honest-degradation pattern, per node), and run-failure messages render
 *    through `sanitizePipelineText` like every other dynamic string.
 */

/** Fake open result: the engine's opaque handle shape (engine-generated id). */
const FAKE_HANDLE: EngineTableHandle = { kind: 'table', id: 't1' }

const FAKE_SCHEMA: readonly { name: string; type: string }[] = [
  { name: 'customer_id', type: 'BIGINT' },
  { name: 'country', type: 'VARCHAR' },
]

/**
 * Distinctive synthetic dataset payload for the value-free leak sweeps:
 * failed/canceled surfaces must carry neither picked names nor dataset
 * text, so the bound files in those tests carry this marker to catch
 * content leaks too. Never a real value.
 */
const DATASET_SENTINEL = 'zq7-dataset-payload'

function fakeBatch(): ArrowTableLike {
  const columns = [{ get: () => 1 }, { get: () => 'SG' }]
  return {
    numRows: 1,
    numCols: columns.length,
    getChildAt: (index: number) => columns[index] ?? null,
  }
}

/** The cli_run-shaped 4-node pipeline (source → rename → filter → sql). */
const PIPELINE_YAML = `version: 1
pipeline: web_pin
nodes:
  by_country:
    type: sql
    inputs: [ sg_only ]
    sql: |
      SELECT country, count(*) AS customers
      FROM sg_only
      GROUP BY country
  customers:
    type: source
    source:
      kind: file
      path: ../csv/customers.csv
  renamed:
    type: transform
    inputs: [ customers ]
    operation:
      rename:
        columns:
          customer_id: customer_ref
  sg_only:
    type: transform
    inputs: [ renamed ]
    operation:
      filter:
        predicates:
          - column: country
            operator: equals
            value: SG
`

/** The gate pipeline (source → filter → validate → publish) for p2-6. */
const GATED_PIPELINE_YAML = `version: 1
pipeline: gate_pin
nodes:
  customers:
    type: source
    source:
      kind: file
      path: ../csv/customers.csv
  gate:
    type: validate
    input: sg
    contract: contracts/strict.yaml
  out:
    type: publish
    input: sg
    requires: [ gate ]
  sg:
    type: transform
    inputs: [ customers ]
    operation:
      filter:
        predicates:
          - column: country
            operator: equals
            value: SG
`

/** A minimal parseable contract for the validate-node binding pins. */
const CONTRACT_YAML = `format: v1
name: gate-contract
version: 1
columns:
  - name: customer_id
    type: BIGINT
    required: true
dataset:
  min-rows: 1
`

/** A malformed contract (columns is not a list) for the parse-error pin. */
const BAD_CONTRACT_YAML = `format: v1
name: broken
version: 1
columns: not-a-list
`

/** An export-mode terminal pipeline for the materialization-badge pins. */
const EXPORT_PIPELINE_YAML = `version: 1
pipeline: export_pin
nodes:
  customers:
    type: source
    source:
      kind: file
      path: ../csv/customers.csv
  dump:
    type: transform
    inputs: [ customers ]
    materialization: export
    operation:
      filter:
        predicates:
          - column: country
            operator: equals
            value: SG
`

/** An ephemeral-mode transform pipeline for the p2-6 fix-round badge pin. */
const EPHEMERAL_PIPELINE_YAML = `version: 1
pipeline: ephemeral_pin
nodes:
  customers:
    type: source
    source:
      kind: file
      path: ../csv/customers.csv
  scratch:
    type: transform
    inputs: [ customers ]
    materialization: ephemeral
    operation:
      filter:
        predicates:
          - column: country
            operator: equals
            value: SG
`

/** Malformed: an unsupported version — the total parser's located error. */
const BAD_YAML = `version: 2
pipeline: future
nodes:
  a:
    type: source
    source:
      kind: file
      path: a.parquet
`

/**
 * A genuinely unrunnable DAG: `renamed` consumes a node that does not exist,
 * so DAG validation refuses it before compilation (the p2-6 panel now LOADS
 * gate pipelines, so a reserved-class document is no longer an invalid one).
 */
const INVALID_YAML = `version: 1
pipeline: broken_pin
nodes:
  renamed:
    type: transform
    inputs: [ missing ]
    operation:
      rename:
        columns:
          customer_id: customer_ref
`

const h = vi.hoisted(() => ({
  /** The picker queue: dataset, pipeline, source — one File per pick. */
  queue: [] as File[],
  /** 'dismissed' makes the next pick resolve null (user cancelled). */
  pickerResult: 'ok' as 'ok' | 'dismissed',
  /** Deferred run outcome handles. */
  resolveRun: null as null | ((result: PipelineRunResult) => void),
  rejectRun: null as null | ((error: unknown) => void),
  /** How many times the engine's runPipeline was invoked. */
  runCalls: 0,
  /** When set, the mocked source handle rejects `getFile` (revoked/unreadable). */
  failGetFile: false,
  /** When set, the p2-1 handle op rejects (an unaddressable relation). */
  failPreview: false,
  /** When set, only the preview's INPUT relation rejects (no schema delta). */
  failPreviewInput: false,
  /**
   * When set to a relation name, ONLY that relation's p2-1 handle op parks
   * until `resolvePreviewRegistration` runs. Scoping the gate to the output
   * relation (the previewed node id) lets the delivery proceed past the
   * output await to the input registration and completion, so a neutralized
   * generation-token guard is actually observable.
   */
  deferPreviewRelation: null as null | string,
  /** Resolves the parked `registerPipelineRelation` (an in-flight preview delivery). */
  resolvePreviewRegistration: null as null | ((handle: EngineTableHandle) => void),
  /**
   * p3-4: the artifact YAMLs the delivery boundary captured (one per
   * export). The derivation itself runs FOR REAL — only the destination
   * acquisition + byte write are faked.
   */
  dcrWrites: [] as string[],
  /** When true, the faked destination acquisition reports the same-source refusal. */
  dcrSameSource: false,
  /** When true, the faked byte write throws (a delivery failure). */
  dcrFailWrite: false,
}))

vi.mock('@assay/data-sources/browser', () => ({
  pickDataFile: async (): Promise<{
    via: string
    source: { getFile: () => Promise<File> }
  } | null> => {
    if (h.pickerResult === 'dismissed') return null
    const file = h.queue.shift()
    if (file === undefined) throw new Error('test picker queue exhausted')
    return {
      via: 'input-fallback',
      source: {
        getFile: async () => {
          if (h.failGetFile) throw new Error('handle revoked')
          return file
        },
      },
    }
  },
}))

vi.mock('./lib/engine', () => ({
  engineClient: {
    open: async () => FAKE_HANDLE,
    schema: async (handle: { readonly id: string }) =>
      handle.id.includes(':renamed')
        ? [
            { name: 'customer_ref', type: 'BIGINT' },
            { name: 'country', type: 'VARCHAR' },
            { name: 'income', type: 'BIGINT' },
          ]
        : FAKE_SCHEMA,
    rowCount: async () => 5,
    fetchRange: async () => ({ batch: fakeBatch(), hasMore: false }),
    overlaySchema: async () => FAKE_SCHEMA,
    overlayRowCount: async () => 5,
    fetchOverlayRange: async () => ({ batch: fakeBatch(), hasMore: false }),
    // p2-6: the p2-1 view-as-handle op the grid-native preview opens through.
    registerPipelineRelation: (relation: string): Promise<EngineTableHandle> => {
      if (h.failPreview || (h.failPreviewInput && relation !== 'by_country')) {
        return Promise.reject(new Error('relation not addressable'))
      }
      if (relation === h.deferPreviewRelation) {
        return new Promise<EngineTableHandle>((resolve) => {
          h.resolvePreviewRegistration = resolve
        })
      }
      return Promise.resolve({ kind: 'table', id: `handle:${relation}` })
    },
    dispose: async () => {},
    /**
     * The deferred runner stand-in: begins the real guard, fires `onNode`
     * for the first node (live-status boundary semantics), then parks the
     * outcome until the test resolves/rejects it. The runner now receives the
     * full IR (so p2-4 gates can execute), whose nodes carry `id`; a compiled
     * plan's nodes carry `nodeId` — accept both.
     */
    runPipeline: (
      input: PipelineRunInput,
      options: PipelineRunOptions,
    ): Promise<PipelineRunResult> => {
      h.runCalls += 1
      options.guard?.begin()
      const nodes = input.nodes as readonly {
        readonly id?: string
        readonly nodeId?: string
        readonly type?: string
        readonly kind?: string
      }[]
      // The IR is canonical (ascending by id), so pick the first SOURCE for
      // the boundary (topological first in these fixtures).
      const first =
        nodes.find((node) => node.type === 'source' || node.kind === 'source') ?? nodes[0]
      if (first === undefined) throw new Error('test expects a pipeline with nodes')
      options.onNode?.(first.nodeId ?? first.id ?? '')
      return new Promise<PipelineRunResult>((resolve, reject) => {
        h.resolveRun = resolve
        h.rejectRun = reject
      })
    },
  },
}))

/**
 * The SQL-pane stub: `App` renders it, but the pipeline journey no longer
 * routes through it — the grid-native preview does. Kept minimal so the
 * pipeline surface renders without an engine.
 */
vi.mock('./pipeline/dcr-export', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pipeline/dcr-export')>()
  return {
    ...actual,
    // The destination boundary: download (or the same-source refusal), so
    // no native picker is touched. Identity is absent in these tests, which
    // is itself the m4-5 rule (download-only by construction) — the branch
    // is pinned in dcr-export.test.ts.
    requestDcrDestination: async () =>
      h.dcrSameSource ? { via: 'refused-source' as const } : { via: 'download' as const },
    writeDcrCopy: async (
      _destination: unknown,
      content: { readonly yaml: string },
    ): Promise<'download'> => {
      if (h.dcrFailWrite) throw new Error('disk full')
      h.dcrWrites.push(content.yaml)
      return 'download' as const
    },
  }
})

vi.mock('./sql/SqlPanel', () => ({
  SqlPanel: (props: { runRequest?: { readonly sql: string } | null }) => (
    <div data-testid="sql-request-record">
      {props.runRequest === null ? 'none' : (props.runRequest?.sql ?? 'none')}
    </div>
  ),
}))
vi.mock('./profile/ProfilePanel', () => ({ ProfilePanel: () => null }))

const COMPLETED_RUN: PipelineRunResult = {
  status: 'completed',
  nodes: [
    { nodeId: 'customers', relation: 'customers', rowCount: 5, materialization: 'view' },
    { nodeId: 'renamed', relation: 'renamed', rowCount: 5, materialization: 'view' },
    { nodeId: 'sg_only', relation: 'sg_only', rowCount: 2, materialization: 'view' },
    { nodeId: 'by_country', relation: 'by_country', rowCount: 1, materialization: 'view' },
  ],
}

function datasetFile(name: string, content = 'id\n1\n'): File {
  return new File([content], name)
}

function yamlFile(name: string, text: string): File {
  return new File([text], name)
}

/** Open the faked dataset through the real flow and wait for the ready UI. */
async function openDataset(name: string): Promise<void> {
  h.queue.push(datasetFile(name))
  await act(async () => {
    fireEvent.click(screen.getByTestId('open-button'))
  })
  await screen.findByTestId('schema-section')
}

/** Open the pipeline panel through the real picker path and wait for loaded. */
async function openPipeline(yaml: string): Promise<void> {
  h.queue.push(yamlFile('pipeline-pin.yaml', yaml))
  await act(async () => {
    fireEvent.click(screen.getByTestId('pipeline-open'))
  })
  await screen.findByTestId('pipeline-summary')
}

afterEach(() => {
  cleanup()
  h.queue.length = 0
  h.pickerResult = 'ok'
  h.resolveRun = null
  h.rejectRun = null
  h.runCalls = 0
  h.failGetFile = false
  h.failPreview = false
  h.failPreviewInput = false
  h.deferPreviewRelation = null
  h.resolvePreviewRegistration = null
  h.dcrWrites.length = 0
  h.dcrSameSource = false
  h.dcrFailWrite = false
})

describe('pipeline panel — placement and empty states (p-5)', () => {
  it('renders the Pipeline section last in the tool pane, with an honest zero state', async () => {
    render(<App />)
    await openDataset('primary.jsonl')

    // Panel-placement ruling (queue 2026-10-02): the pipeline panel is the last
    // tool-pane resident, after profile.
    const rendered = Array.from(
      document.querySelectorAll('.workbench-tools .workbench-section'),
    ).map((section) => section.getAttribute('data-section'))
    expect(rendered[rendered.length - 1]).toBe('pipeline')
    expect(rendered.indexOf('pipeline')).toBeGreaterThan(rendered.indexOf('profile'))

    // The shell owns the managed disclosure; it starts collapsed (one-section
    // first paint) and expanding it mounts/keeps the panel body.
    const toggle = screen.getByTestId('section-toggle-pipeline')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    await act(async () => {
      fireEvent.click(toggle)
    })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByTestId('pipeline-panel')).toBeTruthy()
    expect(screen.getByTestId('pipeline-zero-state').textContent).toMatch(/No pipeline open/)

    // Collapse keeps the body mounted (CSS-only collapse invariant).
    await act(async () => {
      fireEvent.click(toggle)
    })
    expect(document.getElementById('section-pipeline-content')?.hasAttribute('hidden')).toBe(true)
    expect(screen.getByTestId('pipeline-panel')).toBeTruthy()
  })

  it('drops pipeline state when a new dataset session opens (f-1 reset)', async () => {
    render(<App />)
    await openDataset('primary.jsonl')
    await openPipeline(PIPELINE_YAML)
    expect(screen.getByTestId('pipeline-summary')).toBeTruthy()

    // A new dataset open begins a new session: the pipeline state is gone.
    await openDataset('second.jsonl')
    expect(screen.getByTestId('pipeline-zero-state')).toBeTruthy()
    expect(screen.queryByTestId('pipeline-summary')).toBeNull()
  })
})

describe('pipeline panel — honest empty/error states (p-5)', () => {
  it('restores the zero state when the picker is dismissed and reports unreadable files honestly', async () => {
    render(<App />)
    await openDataset('primary.jsonl')

    // Dismissed picker: back to the zero state, nothing loaded.
    h.pickerResult = 'dismissed'
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-open'))
    })
    await screen.findByTestId('pipeline-zero-state')
    expect(screen.queryByTestId('pipeline-read-error')).toBeNull()

    // A file whose text cannot be read: the honest fixed alert, no parse.
    const unreadable = {
      name: 'unreadable.yaml',
      text: async () => {
        throw new Error('stream closed')
      },
    } as unknown as File
    h.pickerResult = 'ok'
    h.queue.push(unreadable)
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-open'))
    })
    const alert = await screen.findByTestId('pipeline-read-error')
    expect(alert.getAttribute('role')).toBe('alert')
    expect(alert.textContent).toMatch(/could not be read/)
    expect(h.runCalls).toBe(0)
  })

  it('renders located parse errors as an alert and executes nothing', async () => {
    render(<App />)
    await openDataset('primary.jsonl')
    h.queue.push(yamlFile('pipeline-pin.yaml', BAD_YAML))
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-open'))
    })

    const alert = await screen.findByTestId('pipeline-parse-errors')
    expect(alert.getAttribute('role')).toBe('alert')
    // Located: the p-1 canonical path:line:column form is present.
    expect(screen.getByTestId('pipeline-parse-error').textContent).toMatch(/\d+:\d+/)
    expect(screen.queryByTestId('pipeline-summary')).toBeNull()
    expect(h.runCalls).toBe(0)
  })

  it('renders DAG/compile refusals as an alert and executes nothing', async () => {
    render(<App />)
    await openDataset('primary.jsonl')
    h.queue.push(yamlFile('pipeline-pin.yaml', INVALID_YAML))
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-open'))
    })

    const alert = await screen.findByTestId('pipeline-invalid')
    expect(alert.getAttribute('role')).toBe('alert')
    // A located, value-free refusal: the missing reference is named.
    expect(screen.getAllByTestId('pipeline-invalid-error').length).toBeGreaterThan(0)
    expect(alert.textContent).toContain('missing')
    expect(screen.queryByTestId('pipeline-summary')).toBeNull()
    expect(h.runCalls).toBe(0)
  })
})

describe('pipeline panel — inspect, sources (C2), run, outputs (p-5)', () => {
  it('lists the DAG in topological order and refuses a run with unbound sources', async () => {
    render(<App />)
    await openDataset('primary.jsonl')
    await openPipeline(PIPELINE_YAML)

    // Summary: authored name + node count + output count + pending sources.
    const summary = screen.getByTestId('pipeline-summary')
    expect(summary.textContent).toContain('web_pin')
    expect(summary.textContent).toContain('4 nodes in execution order')
    expect(summary.textContent).toContain('1 output')
    expect(summary.textContent).toContain('1 source awaiting a dataset')

    // The ordered list: topological (execution) order with kinds/relations.
    const nodes = screen.getAllByTestId('pipeline-node')
    expect(nodes.map((node) => node.getAttribute('data-node-id'))).toEqual([
      'customers',
      'renamed',
      'sg_only',
      'by_country',
    ])
    expect(nodes.map((node) => node.getAttribute('data-node-kind'))).toEqual([
      'source',
      'transform',
      'transform',
      'sql',
    ])
    expect(nodes.every((node) => node.getAttribute('data-node-status') === 'pending')).toBe(true)
    // The output flag lands on the terminal relation only.
    const outputs = screen.getAllByTestId('pipeline-node-output')
    expect(outputs).toHaveLength(1)
    expect(outputs[0].closest('[data-node-id]')?.getAttribute('data-node-id')).toBe('by_country')

    // C2 pending: the source names its honest state and never guesses.
    expect(screen.getByTestId('pipeline-source-pending').textContent).toMatch(
      /No dataset bound yet/,
    )

    // Run with an unbound source: collect-all, disclose, refuse — and the
    // engine was never called.
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-run'))
    })
    const refused = screen.getByTestId('pipeline-run-refused')
    expect(refused.getAttribute('role')).toBe('alert')
    expect(refused.textContent).toContain('customers')
    expect(refused.textContent).toContain('Nothing was executed')
    expect(h.runCalls).toBe(0)
  })

  it('degrades a rejecting source pick honestly (bind-failed alert, retry available, nothing executed)', async () => {
    render(<App />)
    await openDataset('primary.jsonl')
    await openPipeline(PIPELINE_YAML)

    // The pick succeeds but the file handle rejects (revoked/unreadable):
    // the open path's honest-degradation pattern, mirrored per source node
    // (reviewer round 1) — a typed, located, value-free alert, never an
    // unhandled rejection and never a partial binding.
    h.queue.push(datasetFile('source-dataset.parquet', DATASET_SENTINEL))
    h.failGetFile = true
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-bind'))
    })
    const alert = screen.getByTestId('pipeline-source-bind-error')
    expect(alert.getAttribute('role')).toBe('alert')
    expect(alert.getAttribute('data-node-id')).toBe('customers')
    expect(alert.textContent).toMatch(/could not be read/)
    expect(alert.textContent).not.toContain('source-dataset.parquet')
    expect(alert.textContent).not.toContain(DATASET_SENTINEL)
    // Still honestly unbound; nothing was executed.
    expect(screen.queryByTestId('pipeline-source-bound')).toBeNull()
    expect(h.runCalls).toBe(0)

    // The pick gesture stays available: a retry with a readable handle binds.
    h.failGetFile = false
    h.queue.push(datasetFile('source-dataset.parquet', DATASET_SENTINEL))
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-bind'))
    })
    expect(screen.getByTestId('pipeline-source-bound')).toBeTruthy()
    expect(screen.queryByTestId('pipeline-source-bind-error')).toBeNull()
  })

  it('runs serialized with live per-node status, completes with counts, and opens the output grid-native', async () => {
    render(<App />)
    await openDataset('primary.jsonl')
    await openPipeline(PIPELINE_YAML)

    // Bind the source through the real picker path.
    h.queue.push(datasetFile('source-dataset.parquet'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-bind'))
    })
    expect(screen.getByTestId('pipeline-source-bound')).toBeTruthy()
    // Privacy: the picked name is transported, never rendered (ADR 0025).
    expect(document.body.textContent).not.toContain('source-dataset.parquet')

    // Run: the first boundary fired synchronously by the fake → live status.
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-run'))
    })
    expect(h.runCalls).toBe(1)
    const running = screen.getByTestId('pipeline-run-status')
    expect(running.getAttribute('data-state')).toBe('running')

    // Serialization at the UI level: the control is disabled while running.
    const runButton = screen.getByTestId('pipeline-run') as HTMLButtonElement
    expect(runButton.disabled).toBe(true)

    // Live statuses: the first node is running, the rest still pending.
    const nodes = () => screen.getAllByTestId('pipeline-node')
    const statusOf = (id: string): string | null =>
      nodes()
        .find((node) => node.getAttribute('data-node-id') === id)
        ?.getAttribute('data-node-status') ?? null
    expect(statusOf('customers')).toBe('running')
    expect(statusOf('by_country')).toBe('pending')

    // The disabled control is the primary guard: a second click gesture on
    // it does NOT start a second run (React does not dispatch clicks to
    // disabled controls — jsdom included). The in-hook belt-and-braces
    // check cannot be driven through the DOM, so it is pinned directly at
    // the hook level in the describe below.
    await act(async () => {
      fireEvent.click(runButton)
    })
    expect(h.runCalls).toBe(1)
    expect(screen.getByTestId('pipeline-run-status').getAttribute('data-state')).toBe('running')
    expect(nodes().map((node) => node.getAttribute('data-node-status'))).toEqual([
      'running',
      'pending',
      'pending',
      'pending',
    ])

    // Settle: every node done with its real runner-shaped counts.
    await act(async () => {
      h.resolveRun?.(COMPLETED_RUN)
    })
    expect(screen.getByTestId('pipeline-run-status').textContent).toMatch(/Completed/)
    expect(statusOf('customers')).toBe('done')
    expect(statusOf('by_country')).toBe('done')
    const statusTexts = nodes().map(
      (node) => within(node).getByTestId('pipeline-node-status').textContent,
    )
    expect(statusTexts).toEqual(['Done · 5 rows', 'Done · 5 rows', 'Done · 2 rows', 'Done · 1 row'])
    // The session-lifetime disclosure is on the completed surface.
    expect(screen.getByTestId('pipeline-completed-note').textContent).toMatch(
      /closing the tab discards/,
    )
    // The Run control re-enables for an idempotent re-run.
    expect((screen.getByTestId('pipeline-run') as HTMLButtonElement).disabled).toBe(false)

    // Output → the grid-native preview (p2-6): the p2-1 handle op registers
    // the relation and the EXISTING grid model/schema surfaces render it —
    // no SQL-result detour.
    await act(async () => {
      const byCountry = document.querySelector(
        '[data-testid="pipeline-node"][data-node-id="by_country"]',
      ) as HTMLElement
      fireEvent.click(within(byCountry).getByTestId('pipeline-preview-open'))
    })
    const meta = await screen.findByTestId('pipeline-preview-meta')
    expect(meta.textContent).toContain('by_country')
    expect(screen.getByTestId('pipeline-preview-columns').textContent).toContain('customer_id')
    // The generated SQL for the terminal sql node is rendered (sanitized).
    expect(screen.getByTestId('pipeline-preview-sql').textContent).toContain('GROUP BY')
    // The schema delta against the single input (sg_only) is empty here.
    expect(screen.getByTestId('pipeline-preview-delta-empty')).toBeTruthy()
    // The preview grid renders through the real DataGrid renderer.
    expect(
      screen.getByTestId('pipeline-preview-grid').querySelector('[data-testid="grid"]'),
    ).not.toBeNull()
    // Close returns to the list without changing anything.
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-preview-close'))
    })
    expect(screen.queryByTestId('pipeline-preview')).toBeNull()
  })

  it('surfaces the typed canceled outcome with the named partial and next node', async () => {
    render(<App />)
    await openDataset('primary.jsonl')
    await openPipeline(PIPELINE_YAML)
    h.queue.push(datasetFile('source-dataset.parquet', DATASET_SENTINEL))
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-bind'))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-run'))
    })

    // Cancel: UI-level abandonment request — disclosed as boundary-scoped
    // while the runner is still between boundaries.
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-cancel'))
    })
    expect(screen.getByTestId('pipeline-run-status').textContent).toMatch(/Cancelling/)
    expect((screen.getByTestId('pipeline-cancel') as HTMLButtonElement).disabled).toBe(true)

    // The runner's typed outcome lands at the boundary: named partial +
    // next node, honestly rendered.
    await act(async () => {
      h.resolveRun?.({
        status: 'canceled',
        nodes: [
          { nodeId: 'customers', relation: 'customers', rowCount: 5, materialization: 'view' },
        ],
        nextNodeId: 'renamed',
      })
    })
    expect(screen.getByTestId('pipeline-run-status').textContent).toMatch(/Cancelled/)
    const note = screen.getByTestId('pipeline-run-cancelled')
    expect(note.textContent).toContain('renamed')
    expect(note.textContent).toContain('customers')
    expect(note.textContent).toMatch(/node boundaries/)
    // Negative pin (reviewer round 1): the canceled surface is value-free
    // too — neither the picked source file name nor any dataset text.
    expect(note.textContent).not.toContain('source-dataset.parquet')
    expect(note.textContent).not.toContain(DATASET_SENTINEL)
    expect(document.body.textContent).not.toContain('source-dataset.parquet')
    expect(document.body.textContent).not.toContain(DATASET_SENTINEL)
  })

  it('renders a failed run value-free with the failing node and named partial state', async () => {
    render(<App />)
    await openDataset('primary.jsonl')
    await openPipeline(PIPELINE_YAML)
    h.queue.push(datasetFile('source-dataset.parquet', DATASET_SENTINEL))
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-bind'))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-run'))
    })

    await act(async () => {
      h.rejectRun?.(
        new PipelineRunError('sg_only', [
          { nodeId: 'customers', relation: 'customers' },
          { nodeId: 'renamed', relation: 'renamed' },
        ]),
      )
    })
    const failed = screen.getByTestId('pipeline-run-failed')
    expect(failed.getAttribute('role')).toBe('alert')
    expect(failed.textContent).toContain('sg_only')
    expect(failed.textContent).toContain('customers')
    expect(failed.textContent).toContain('renamed')
    // Negative pin (reviewer round 1): the failed surface is value-free —
    // neither the picked source file name nor any dataset text may appear,
    // on the alert or anywhere on the page (the runner's fixed message
    // class carries no values; a mutant embedding picked names or dataset
    // content into the failure `message` must fail here).
    expect(failed.textContent).not.toContain('source-dataset.parquet')
    expect(failed.textContent).not.toContain(DATASET_SENTINEL)
    expect(document.body.textContent).not.toContain('source-dataset.parquet')
    expect(document.body.textContent).not.toContain(DATASET_SENTINEL)
    // No terminal relation materialized, so the terminal node has no
    // preview; the two partial relations DO (they materialized).
    expect(
      document.querySelector('[data-testid="pipeline-preview-open"][data-node-id="by_country"]'),
    ).toBeNull()
  })

  it('renders an executed gate verdict on the failure path (p2c-4)', async () => {
    render(<App />)
    await openDataset('primary.jsonl')
    await openPipeline(GATED_PIPELINE_YAML)
    h.queue.push(datasetFile('source-dataset.parquet', DATASET_SENTINEL))
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-bind'))
    })
    h.queue.push(yamlFile('gate-contract.yaml', CONTRACT_YAML))
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-bind-contract'))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-run'))
    })
    expect(h.runCalls).toBe(1)

    // p2c-1: a later node (`out`) fails after the validate gate executed, so
    // the gate's value-free verdict rides `error.partial[].gate`. p2c-4
    // passes that verdict through (mirroring `toOutcome`) so the panel
    // renders it, not just the CLI.
    await act(async () => {
      h.rejectRun?.(
        new PipelineRunError('out', [
          { nodeId: 'customers', relation: 'customers' },
          { nodeId: 'sg', relation: 'sg' },
          {
            nodeId: 'gate',
            relation: 'sg',
            gate: { class: 'validate', input: 'sg', valid: false, violatedRules: 2 },
          },
        ]),
      )
    })

    expect(screen.getByTestId('pipeline-run-status').getAttribute('data-state')).toBe('failed')
    const gateRow = document.querySelector(
      '[data-testid="pipeline-node"][data-node-id="gate"]',
    ) as HTMLElement
    expect(within(gateRow).getByTestId('pipeline-node-gate').textContent).toContain(
      'Validate: failed — 2 rules violated',
    )
    expect(gateRow.getAttribute('data-node-status')).toBe('done')
    // A partial entry WITHOUT a verdict renders exactly as before: done, no
    // gate text.
    const sourceRow = document.querySelector(
      '[data-testid="pipeline-node"][data-node-id="customers"]',
    ) as HTMLElement
    expect(sourceRow.getAttribute('data-node-status')).toBe('done')
    expect(within(sourceRow).queryByTestId('pipeline-node-gate')).toBeNull()
    // The failing node is never in `partial` — no verdict is fabricated.
    const outRow = document.querySelector(
      '[data-testid="pipeline-node"][data-node-id="out"]',
    ) as HTMLElement
    expect(outRow.getAttribute('data-node-status')).toBe('failed')
    expect(within(outRow).queryByTestId('pipeline-node-gate')).toBeNull()
    // Value-free (ADR 0025): the verdict carries counts only — never the
    // picked source name nor any dataset text.
    const failed = screen.getByTestId('pipeline-run-failed')
    expect(failed.textContent).not.toContain('source-dataset.parquet')
    expect(failed.textContent).not.toContain(DATASET_SENTINEL)
    expect(document.body.textContent).not.toContain('source-dataset.parquet')
    expect(document.body.textContent).not.toContain(DATASET_SENTINEL)
  })

  it('drops a late run outcome when a new dataset session supersedes it', async () => {
    render(<App />)
    await openDataset('primary.jsonl')
    await openPipeline(PIPELINE_YAML)
    h.queue.push(datasetFile('source-dataset.parquet'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-bind'))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-run'))
    })
    expect(h.runCalls).toBe(1)

    // A new dataset open begins a new session (the f-1 reset): the pipeline
    // state is dropped and the in-flight run's token is superseded.
    await openDataset('second.jsonl')
    await act(async () => {
      h.resolveRun?.(COMPLETED_RUN)
    })
    // The late outcome is dropped — it never resurrects a completed surface.
    expect(screen.getByTestId('pipeline-zero-state')).toBeTruthy()
    expect(screen.queryByTestId('pipeline-run-status')).toBeNull()
  })

  it('renders the runner refusal class and non-typed engine failures value-free', async () => {
    render(<App />)
    await openDataset('primary.jsonl')
    await openPipeline(PIPELINE_YAML)
    h.queue.push(datasetFile('source-dataset.parquet'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-bind'))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-run'))
    })

    // The refusal class renders honestly as a refused state: fixed class
    // text, named node, nothing fabricated.
    await act(async () => {
      h.rejectRun?.(new PipelineRunRefusalError('missing-source', 'customers'))
    })
    const refused = screen.getByTestId('pipeline-run-refused')
    expect(refused.getAttribute('role')).toBe('alert')
    expect(refused.textContent).toContain('customers')
    expect(refused.textContent).toContain('no dataset binding')

    // A re-run replaces the failure; a non-typed engine failure renders the
    // readable message with no failing node (it predates node execution).
    // The message rides `sanitizePipelineText` like every other dynamic
    // pipeline string (reviewer round 1): the Error text's control character
    // renders as a visible escape, and no picked name leaks.
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-run'))
    })
    await act(async () => {
      h.rejectRun?.(new Error('the engine worker died\u001b[31m'))
    })
    const failed = screen.getByTestId('pipeline-run-failed')
    expect(failed.textContent).toContain('before any node executed')
    expect(failed.textContent).toContain('the engine worker died\\u001b[31m')
    expect(document.body.textContent).not.toContain('source-dataset.parquet')
  })

  it('clears the run live region when a new pipeline supersedes the old one', async () => {
    render(<App />)
    await openDataset('primary.jsonl')
    await openPipeline(PIPELINE_YAML)
    h.queue.push(datasetFile('source-dataset.parquet'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-bind'))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-run'))
    })
    await act(async () => {
      h.resolveRun?.(COMPLETED_RUN)
    })
    expect(screen.getByTestId('pipeline-live-region').textContent).toMatch(/completed/)

    // A new pipeline document resets the run state; the stale announcement
    // must not survive it.
    await openPipeline(PIPELINE_YAML)
    expect(screen.getByTestId('pipeline-live-region').textContent).toBe('')
    expect(screen.getByTestId('pipeline-run-status').textContent).toMatch(/Not run yet/)
  })

  it('keeps picked file names out of the rendered page (ADR 0025 sweep)', async () => {
    render(<App />)
    await openDataset('primary.jsonl')
    await openPipeline(PIPELINE_YAML)
    h.queue.push(datasetFile('source-dataset.parquet'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-bind'))
    })
    expect(document.body.textContent).not.toContain('primary.jsonl')
    expect(document.body.textContent).not.toContain('pipeline-pin.yaml')
    expect(document.body.textContent).not.toContain('source-dataset.parquet')
  })
})

describe('pipeline panel — gates, contracts, lineage, badges, preview (p2-6)', () => {
  it('loads a gated pipeline, renders badges and lineage, and refuses an unbound-contract run', async () => {
    render(<App />)
    await openDataset('primary.jsonl')
    await openPipeline(GATED_PIPELINE_YAML)

    // Gate nodes load (the data subgraph compiles; the runner binds gates).
    expect(screen.getByTestId('pipeline-summary').textContent).toContain(
      '1 validate node awaiting a contract',
    )
    const kinds = screen
      .getAllByTestId('pipeline-node')
      .map((node) => node.getAttribute('data-node-kind'))
    expect(kinds).toEqual(['source', 'transform', 'validate', 'publish'])
    // Materialization badges: source / view / gate / gate.
    expect(
      screen
        .getAllByTestId('pipeline-node-materialization')
        .map((badge) => badge.getAttribute('data-materialization')),
    ).toEqual(['source', 'view', 'gate', 'gate'])

    // Lineage (arch §16): dataset consumers are transitive; publish requires.
    const datasetLineage = screen.getByTestId('pipeline-lineage-datasets').textContent ?? ''
    expect(datasetLineage).toContain('customers')
    expect(datasetLineage).toContain('sg')
    expect(datasetLineage).toContain('gate')
    expect(datasetLineage).toContain('out')
    const nodeLineage = screen.getByTestId('pipeline-lineage-nodes').textContent ?? ''
    expect(nodeLineage).toContain('requires')

    // Bind the source, then run: the missing contract is collected, disclosed,
    // and the engine is never called.
    h.queue.push(datasetFile('source-dataset.parquet'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-bind'))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-run'))
    })
    const refused = screen.getByTestId('pipeline-run-refused')
    expect(refused.getAttribute('role')).toBe('alert')
    expect(refused.textContent).toContain('Missing contracts')
    expect(refused.textContent).toContain('gate')
    expect(h.runCalls).toBe(0)
  })

  it('binds a contract, surfaces the gated outcome, and unblocks after re-binding a passing contract', async () => {
    render(<App />)
    await openDataset('primary.jsonl')
    await openPipeline(GATED_PIPELINE_YAML)
    h.queue.push(datasetFile('source-dataset.parquet'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-bind'))
    })

    // C2: the contract comes from an explicit pick, parsed for real.
    h.queue.push(yamlFile('gate-contract.yaml', CONTRACT_YAML))
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-bind-contract'))
    })
    expect(screen.getByTestId('pipeline-contract-bound')).toBeTruthy()
    expect(screen.getByTestId('pipeline-contract-bound').getAttribute('data-bind-revision')).toBe(
      '1',
    )
    expect(document.body.textContent).not.toContain('gate-contract.yaml')

    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-run'))
    })
    expect(h.runCalls).toBe(1)

    // The p2-4 gated outcome: the run stopped at the blocked publish, the
    // failed validate verdict is named value-free, and the run state is NOT
    // mistaken for a cancellation.
    await act(async () => {
      h.resolveRun?.({
        status: 'gated',
        gatedAt: 'out',
        gate: 'publish-blocked',
        nextNodeId: null,
        nodes: [
          { nodeId: 'customers', relation: 'customers', rowCount: 5, materialization: 'source' },
          { nodeId: 'sg', relation: 'sg', rowCount: 2, materialization: 'view' },
          {
            nodeId: 'gate',
            relation: 'sg',
            rowCount: 2,
            materialization: 'gate',
            gate: { class: 'validate', input: 'sg', valid: false, violatedRules: 1 },
          },
          {
            nodeId: 'out',
            relation: 'sg',
            rowCount: 2,
            materialization: 'gate',
            gate: { class: 'publish', input: 'sg', blockedGates: ['gate'] },
          },
        ],
      })
    })
    expect(screen.getByTestId('pipeline-run-status').getAttribute('data-state')).toBe('gated')
    const gated = screen.getByTestId('pipeline-run-gated')
    expect(gated.getAttribute('role')).toBe('alert')
    expect(gated.textContent).toContain('out')
    expect(gated.textContent).toContain('publish gate is blocked')
    expect(screen.getByTestId('pipeline-run-gated-detail').textContent).toContain('gate')
    const gateRow = document.querySelector(
      '[data-testid="pipeline-node"][data-node-id="gate"]',
    ) as HTMLElement
    expect(within(gateRow).getByTestId('pipeline-node-gate').textContent).toContain(
      'Validate: failed — 1 rule violated',
    )
    const outRow = document.querySelector(
      '[data-testid="pipeline-node"][data-node-id="out"]',
    ) as HTMLElement
    expect(within(outRow).getByTestId('pipeline-node-gate').textContent).toContain(
      'Publish: blocked by gate',
    )
    expect(outRow.getAttribute('data-node-status')).toBe('gated')

    // Fix: re-bind a passing contract, re-run → completed, gate passes.
    h.queue.push(yamlFile('gate-contract-pass.yaml', CONTRACT_YAML))
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-bind-contract'))
    })
    // The replacement is observable value-free: the bind revision advances
    // (the file identity itself is never rendered — ADR 0025).
    expect(screen.getByTestId('pipeline-contract-bound').getAttribute('data-bind-revision')).toBe(
      '2',
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-run'))
    })
    await act(async () => {
      h.resolveRun?.({
        status: 'completed',
        nodes: [
          { nodeId: 'customers', relation: 'customers', rowCount: 5, materialization: 'source' },
          { nodeId: 'sg', relation: 'sg', rowCount: 2, materialization: 'view' },
          {
            nodeId: 'gate',
            relation: 'sg',
            rowCount: 2,
            materialization: 'gate',
            gate: { class: 'validate', input: 'sg', valid: true, violatedRules: 0 },
          },
          {
            nodeId: 'out',
            relation: 'sg',
            rowCount: 2,
            materialization: 'gate',
            gate: { class: 'publish', input: 'sg', blockedGates: [] },
          },
        ],
      })
    })
    expect(screen.getByTestId('pipeline-run-status').getAttribute('data-state')).toBe('completed')
    expect(within(gateRow).getByTestId('pipeline-node-gate').textContent).toBe('Validate: passed')
    expect(within(outRow).getByTestId('pipeline-node-gate').textContent).toBe(
      'Publish: gate passed',
    )
  })

  it('renders the schema delta against the node input in the grid-native preview', async () => {
    render(<App />)
    await openDataset('primary.jsonl')
    await openPipeline(PIPELINE_YAML)
    h.queue.push(datasetFile('source-dataset.parquet'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-bind'))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-run'))
    })
    await act(async () => {
      h.resolveRun?.(COMPLETED_RUN)
    })

    const renamedRow = document.querySelector(
      '[data-testid="pipeline-node"][data-node-id="renamed"]',
    ) as HTMLElement
    await act(async () => {
      fireEvent.click(within(renamedRow).getByTestId('pipeline-preview-open'))
    })
    await screen.findByTestId('pipeline-preview-meta')
    // The mock's renamed relation schema differs from its input (customers):
    // customer_ref added, customer_id removed.
    const added = screen.getAllByTestId('pipeline-preview-added').map((li) => li.textContent)
    const removed = screen.getAllByTestId('pipeline-preview-removed').map((li) => li.textContent)
    expect(added.join(' ')).toContain('customer_ref')
    expect(removed.join(' ')).toContain('customer_id')
    expect(document.body.textContent).not.toContain('source-dataset.parquet')
  })

  it('degrades an unaddressable preview honestly (value-free alert, nothing changed)', async () => {
    render(<App />)
    await openDataset('primary.jsonl')
    await openPipeline(PIPELINE_YAML)
    h.queue.push(datasetFile('source-dataset.parquet', DATASET_SENTINEL))
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-bind'))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-run'))
    })
    await act(async () => {
      h.resolveRun?.(COMPLETED_RUN)
    })

    h.failPreview = true
    const byCountryRow = document.querySelector(
      '[data-testid="pipeline-node"][data-node-id="by_country"]',
    ) as HTMLElement
    await act(async () => {
      fireEvent.click(within(byCountryRow).getByTestId('pipeline-preview-open'))
    })
    const error = await screen.findByTestId('pipeline-preview-error')
    expect(error.getAttribute('role')).toBe('alert')
    expect(error.textContent).toMatch(/could not be opened for preview/)
    // Value-free: no relation, engine text, picked name, or dataset content.
    expect(error.textContent).not.toContain('by_country')
    expect(error.textContent).not.toContain('source-dataset.parquet')
    expect(error.textContent).not.toContain(DATASET_SENTINEL)
  })

  it('renders an export node’s artifact value-free and offers no preview for it', async () => {
    render(<App />)
    await openDataset('primary.jsonl')
    await openPipeline(EXPORT_PIPELINE_YAML)
    h.queue.push(datasetFile('source-dataset.parquet'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-bind'))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-run'))
    })
    await act(async () => {
      h.resolveRun?.({
        status: 'completed',
        nodes: [
          { nodeId: 'customers', relation: 'customers', rowCount: 5, materialization: 'source' },
          {
            nodeId: 'dump',
            relation: 'dump',
            rowCount: 2,
            materialization: 'export',
            exportPath: 'assay-exports/assay-pipeline-export-dump.parquet',
          },
        ],
      })
    })
    const dumpRow = document.querySelector(
      '[data-testid="pipeline-node"][data-node-id="dump"]',
    ) as HTMLElement
    expect(
      within(dumpRow)
        .getByTestId('pipeline-node-materialization')
        .getAttribute('data-materialization'),
    ).toBe('export')
    expect(within(dumpRow).getByTestId('pipeline-node-export').textContent).toContain(
      'assay-pipeline-export-dump.parquet',
    )
    // An export writes an OPFS artifact, not a session relation: no preview.
    expect(within(dumpRow).queryByTestId('pipeline-preview-open')).toBeNull()
  })

  it('keeps an ephemeral node’s badge before and after the run (never flips to view)', async () => {
    render(<App />)
    await openDataset('primary.jsonl')
    await openPipeline(EPHEMERAL_PIPELINE_YAML)

    const badge = (): HTMLElement => {
      const row = document.querySelector(
        '[data-testid="pipeline-node"][data-node-id="scratch"]',
      ) as HTMLElement
      return within(row).getByTestId('pipeline-node-materialization')
    }
    // Pre-run: the plan's effective ADR 0033 mode — the `view` statement kind
    // an ephemeral node compiles to is not its badge.
    expect(badge().getAttribute('data-materialization')).toBe('ephemeral')
    expect(badge().textContent).toBe('ephemeral')

    h.queue.push(datasetFile('source-dataset.parquet'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-bind'))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-run'))
    })
    await act(async () => {
      h.resolveRun?.({
        status: 'completed',
        nodes: [
          { nodeId: 'customers', relation: 'customers', rowCount: 5, materialization: 'source' },
          { nodeId: 'scratch', relation: 'scratch', rowCount: 2, materialization: 'ephemeral' },
        ],
      })
    })
    // The p2-4 outcome is authoritative post-run; it stays `ephemeral`.
    expect(badge().getAttribute('data-materialization')).toBe('ephemeral')
    expect(badge().textContent).toBe('ephemeral')
  })

  it('degrades an unparseable contract honestly and refuses the run with the node disclosed', async () => {
    render(<App />)
    await openDataset('primary.jsonl')
    await openPipeline(GATED_PIPELINE_YAML)
    h.queue.push(datasetFile('source-dataset.parquet'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-bind'))
    })
    h.queue.push(yamlFile('broken-contract.yaml', BAD_CONTRACT_YAML))
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-bind-contract'))
    })
    const alert = screen.getByTestId('pipeline-contract-parse-error')
    expect(alert.getAttribute('role')).toBe('alert')
    expect(alert.textContent).toMatch(/could not be parsed/)
    // The node is still unbound, so a run is refused (collect-all-disclose).
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-run'))
    })
    const refused = screen.getByTestId('pipeline-run-refused')
    expect(refused.textContent).toContain('Missing contracts')
    expect(refused.textContent).toContain('gate')
    expect(h.runCalls).toBe(0)
  })

  it('degrades an unreadable contract honestly (retry available, nothing bound)', async () => {
    render(<App />)
    await openDataset('primary.jsonl')
    await openPipeline(GATED_PIPELINE_YAML)
    h.queue.push(datasetFile('source-dataset.parquet'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-bind'))
    })
    const unreadable = {
      name: 'unreadable.contract.yaml',
      size: 10,
      text: async () => {
        throw new Error('stream closed')
      },
    } as unknown as File
    h.queue.push(unreadable)
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-bind-contract'))
    })
    const alert = screen.getByTestId('pipeline-contract-read-error')
    expect(alert.getAttribute('role')).toBe('alert')
    expect(alert.textContent).toMatch(/could not be read/)
    // Still unbound, so the pick gesture remains available.
    expect(screen.queryByTestId('pipeline-contract-bound')).toBeNull()
    expect(screen.getByTestId('pipeline-bind-contract')).toBeTruthy()
  })

  it('omits the schema delta honestly when the input relation is not addressable', async () => {
    render(<App />)
    await openDataset('primary.jsonl')
    await openPipeline(PIPELINE_YAML)
    h.queue.push(datasetFile('source-dataset.parquet'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-bind'))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-run'))
    })
    await act(async () => {
      h.resolveRun?.(COMPLETED_RUN)
    })

    // The OUTPUT relation registers; its input does not. The preview still
    // renders the output, with the delta honestly absent (never guessed).
    h.failPreviewInput = true
    const byCountryRow = document.querySelector(
      '[data-testid="pipeline-node"][data-node-id="by_country"]',
    ) as HTMLElement
    await act(async () => {
      fireEvent.click(within(byCountryRow).getByTestId('pipeline-preview-open'))
    })
    await screen.findByTestId('pipeline-preview-meta')
    expect(screen.getByTestId('pipeline-preview-columns')).toBeTruthy()
    expect(screen.queryByTestId('pipeline-preview-delta')).toBeNull()
    expect(screen.queryByTestId('pipeline-preview-delta-empty')).toBeNull()
  })
})

/** A minimal DatasetSession for hook-level pins (no App, no DOM). */
function stubSession(): DatasetSession {
  return {
    tokenRef: { current: 0 },
    beginSession: () => 0,
    registerReset: () => () => {},
  }
}

describe('pipeline session hook — in-flight run serialization (p-5, reviewer round 1)', () => {
  it('makes a second run() while in flight a no-op: one engine call, no state clobber', async () => {
    const { result } = renderHook(() =>
      usePipelineSession({ session: stubSession(), sourceIdentityRef: { current: null } }),
    )

    // Load the pipeline through the mocked picker (parse → validate →
    // compile run FOR REAL) and bind its single source.
    h.queue.push(yamlFile('pipeline-pin.yaml', PIPELINE_YAML))
    await act(async () => {
      result.current.openPipelineFile()
    })
    expect(result.current.fileState.kind).toBe('loaded')
    h.queue.push(datasetFile('source-dataset.parquet', DATASET_SENTINEL))
    await act(async () => {
      result.current.bindSourceDataset('customers')
    })
    expect(result.current.bindings['customers']?.kind).toBe('bound')

    // First run: in flight (the fake parks the runner promise).
    await act(async () => {
      result.current.run()
    })
    expect(h.runCalls).toBe(1)
    expect(result.current.runState.kind).toBe('running')

    // Request cancellation mid-flight, THEN drive a second run(): the
    // in-hook guard must refuse it. This is the exact hole the disabled
    // control cannot close (React swallows the DOM gesture) — the hook
    // double-check is the last line of defense.
    await act(async () => {
      result.current.cancelRun()
    })
    await act(async () => {
      result.current.run()
    })

    // One engine call — a guard-less second run would invoke the engine
    // again (runCalls 2).
    expect(h.runCalls).toBe(1)
    // The in-flight state was NOT clobbered: a guard-less second run would
    // reset cancelRequested to false and the statuses to all-pending.
    const running = result.current.runState
    if (running.kind !== 'running') throw new Error('expected the run to stay in flight')
    expect(running.cancelRequested).toBe(true)
    expect(running.statuses).toEqual({
      customers: 'running',
      renamed: 'pending',
      sg_only: 'pending',
      by_country: 'pending',
    })

    // The original run still settles honestly (typed canceled outcome).
    await act(async () => {
      h.resolveRun?.({
        status: 'canceled',
        nodes: [
          { nodeId: 'customers', relation: 'customers', rowCount: 5, materialization: 'view' },
        ],
        nextNodeId: 'renamed',
      })
    })
    expect(result.current.runState.kind).toBe('canceled')
  })
})

describe('pipeline session hook — stale-preview lifecycle (p2-6, fix round)', () => {
  /** Load the fixture pipeline and bind its single source through the picker. */
  async function loadAndBind(result: {
    current: ReturnType<typeof usePipelineSession>
  }): Promise<void> {
    h.queue.push(yamlFile('pipeline-pin.yaml', PIPELINE_YAML))
    await act(async () => {
      result.current.openPipelineFile()
    })
    h.queue.push(datasetFile('source-dataset.parquet'))
    await act(async () => {
      result.current.bindSourceDataset('customers')
    })
  }

  it('closes an open preview and drops a late preview delivery when a run starts', async () => {
    const { result } = renderHook(() =>
      usePipelineSession({ session: stubSession(), sourceIdentityRef: { current: null } }),
    )
    await loadAndBind(result)

    // (a) An open (ready) preview is closed the moment a run starts.
    await act(async () => {
      result.current.openPreview('by_country')
    })
    expect(result.current.preview.kind).toBe('ready')
    await act(async () => {
      result.current.run()
    })
    expect(result.current.preview.kind).toBe('closed')

    // Settle the run so a second run is permitted below.
    await act(async () => {
      h.resolveRun?.({
        status: 'canceled',
        nodes: [
          { nodeId: 'customers', relation: 'customers', rowCount: 5, materialization: 'view' },
        ],
        nextNodeId: 'renamed',
      })
    })

    // (b) A deferred preview delivery that resolves AFTER the run started is
    // dropped by the generation token — it must not reopen the preview. The
    // gate parks ONLY the output relation, so with the guard neutralized the
    // delivery runs to completion (input registered, model loaded) and would
    // reopen the preview; the token guard is what keeps it closed.
    h.deferPreviewRelation = 'by_country'
    await act(async () => {
      result.current.openPreview('by_country')
    })
    expect(result.current.preview.kind).toBe('loading')
    await act(async () => {
      result.current.run()
    })
    expect(result.current.preview.kind).toBe('closed')
    await act(async () => {
      h.resolvePreviewRegistration?.({ kind: 'table', id: 'handle:by_country' })
    })
    expect(result.current.preview.kind).toBe('closed')
  })

  it("closes the previous pipeline's preview when a new pipeline document opens", async () => {
    const { result } = renderHook(() =>
      usePipelineSession({ session: stubSession(), sourceIdentityRef: { current: null } }),
    )
    await loadAndBind(result)

    await act(async () => {
      result.current.openPreview('by_country')
    })
    expect(result.current.preview.kind).toBe('ready')

    // A new pipeline document supersedes the old one; its preview must not
    // survive into the new document.
    h.queue.push(yamlFile('pipeline-pin-2.yaml', PIPELINE_YAML))
    await act(async () => {
      result.current.openPipelineFile()
    })
    expect(result.current.fileState.kind).toBe('loaded')
    expect(result.current.preview.kind).toBe('closed')
  })
})

describe('pipeline panel — the DCR artifact export (p3-4)', () => {
  /** Drive one completed run of the golden-twin pipeline and return the panel. */
  async function completedRun(): Promise<void> {
    render(<App />)
    await openDataset('primary.jsonl')
    await act(async () => {
      fireEvent.click(screen.getByTestId('section-toggle-pipeline'))
    })
    await openPipeline(PIPELINE_YAML)
    h.queue.push(datasetFile('customers.csv'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-bind'))
    })
    await screen.findByTestId('pipeline-source-bound')
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-run'))
    })
    await act(async () => {
      h.resolveRun?.(COMPLETED_RUN)
    })
    await screen.findByTestId('pipeline-dcr-export')
  }

  function setSide(prefix: 'base' | 'candidate', node: string, datasetId: string): void {
    fireEvent.change(screen.getByTestId(`pipeline-dcr-${prefix}-node`), {
      target: { value: node },
    })
    fireEvent.change(screen.getByTestId(`pipeline-dcr-${prefix}-dataset`), {
      target: { value: datasetId },
    })
  }

  it('offers the materialized data nodes as sides on a completed run (never source nodes)', async () => {
    await completedRun()
    const options = Array.from(
      screen.getByTestId('pipeline-dcr-base-node').querySelectorAll('option'),
    )
      .map((option) => option.getAttribute('value'))
      .filter((value) => value !== '')
    expect(options).toEqual(['customers', 'renamed', 'sg_only', 'by_country'])
    // The export control is disabled until BOTH sides are stated (C2).
    expect((screen.getByTestId('pipeline-dcr-export-run') as HTMLButtonElement).disabled).toBe(true)
  })

  it('the export is absent before a run and on a canceled run', async () => {
    render(<App />)
    await openDataset('primary.jsonl')
    await act(async () => {
      fireEvent.click(screen.getByTestId('section-toggle-pipeline'))
    })
    await openPipeline(PIPELINE_YAML)
    expect(screen.queryByTestId('pipeline-dcr-export')).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-run'))
    })
    await act(async () => {
      h.resolveRun?.({ status: 'canceled', nextNodeId: null, nodes: [] })
    })
    expect(screen.queryByTestId('pipeline-dcr-export')).toBeNull()
  })

  it('derives for real and delivers: the artifact is a new file, value-free, unchanged source', async () => {
    await completedRun()
    setSide('base', 'renamed', 'customers_base')
    setSide('candidate', 'by_country', 'customers_by_country')
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-dcr-export-run'))
    })
    const result = await screen.findByTestId('pipeline-dcr-export-result')
    expect(result.textContent).toContain('new file')
    expect(result.textContent).toContain('The opened file is unchanged')

    // The REAL derivation produced a real canonical artifact through the
    // shared builder (no web-side re-serialization).
    expect(h.dcrWrites).toHaveLength(1)
    const yaml = h.dcrWrites[0] ?? ''
    expect(yaml.startsWith('format: assay-dcr\nversion: 1\n')).toBe(true)
    expect(yaml).toContain('assay-schema-fingerprint-v1')
    expect(yaml).toContain('customers_base')
    expect(yaml).toContain('customers_by_country')
    // Value-free (ADR 0025): no dataset cell value, no picked file name.
    expect(yaml).not.toContain('SG')
    expect(yaml).not.toContain('52000')
    expect(yaml).not.toContain('customers.csv')
    // The result line never names a file path either.
    expect(result.textContent).not.toContain('customers.csv')
  })

  it('the same node on both sides refuses loudly before any derivation or write', async () => {
    await completedRun()
    setSide('base', 'renamed', 'customers_base')
    setSide('candidate', 'renamed', 'customers_other')
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-dcr-export-run'))
    })
    const refused = await screen.findByTestId('pipeline-dcr-export-refused')
    expect(refused.getAttribute('data-reason')).toBe('same-node')
    expect(refused.textContent).toContain('must be different nodes')
    expect(refused.textContent).toContain('Nothing was written')
    expect(h.dcrWrites).toHaveLength(0)
  })

  it('the D19-OQ-5 liveness refusal: an unresolvable relation surfaces the typed alert, nothing written', async () => {
    h.failPreview = true
    await completedRun()
    setSide('base', 'renamed', 'customers_base')
    setSide('candidate', 'by_country', 'customers_by_country')
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-dcr-export-run'))
    })
    const refused = await screen.findByTestId('pipeline-dcr-export-refused')
    expect(refused.getAttribute('data-reason')).toBe('dangling-materialization')
    expect(refused.textContent).toContain('no longer')
    expect(refused.textContent).toContain('Nothing was written')
    expect(h.dcrWrites).toHaveLength(0)
  })

  it('the same-source refusal and the failure state render as alerts, nothing written', async () => {
    await completedRun()
    setSide('base', 'renamed', 'customers_base')
    setSide('candidate', 'by_country', 'customers_by_country')
    h.dcrSameSource = true
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-dcr-export-run'))
    })
    const refused = await screen.findByTestId('pipeline-dcr-export-same-source')
    expect(refused.textContent).toContain('Nothing was written')
    expect(h.dcrWrites).toHaveLength(0)

    // A delivery failure: the honest failure line, still nothing written.
    h.dcrSameSource = false
    h.dcrFailWrite = true
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-dcr-export-run'))
    })
    const failed = await screen.findByTestId('pipeline-dcr-export-failed')
    expect(failed.textContent).toContain('disk full')
    expect(failed.textContent).toContain('No file was written')
    expect(h.dcrWrites).toHaveLength(0)
  })

  it('a newer run resets a previous export result line', async () => {
    await completedRun()
    setSide('base', 'renamed', 'customers_base')
    setSide('candidate', 'by_country', 'customers_by_country')
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-dcr-export-run'))
    })
    await screen.findByTestId('pipeline-dcr-export-result')
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-run'))
    })
    // While the new run is in flight the section hides with the run state.
    expect(screen.queryByTestId('pipeline-dcr-export')).toBeNull()
    await act(async () => {
      h.resolveRun?.(COMPLETED_RUN)
    })
    await screen.findByTestId('pipeline-dcr-export')
    expect(screen.queryByTestId('pipeline-dcr-export-result')).toBeNull()
  })
})
