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
 * SqlPanel (replaced by a recording stub so the output-jump seam is
 * observable without an engine). parsePipeline/validatePipeline/
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
 * 5. outputs → the EXISTING result surface: "View output" hands the exact
 *    quoted `SELECT * FROM "relation"` to the SQL pane's `runRequest` seam;
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

/** The reserved-class shape (fixtures/pipeline/hostile-names.yaml's gist). */
const RESERVED_YAML = `version: 1
pipeline: reserved_pin
nodes:
  a:
    type: source
    source:
      kind: file
      path: a.parquet
  gate:
    type: publish
    input: a
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
    schema: async () => FAKE_SCHEMA,
    rowCount: async () => 5,
    fetchRange: async () => ({ batch: fakeBatch(), hasMore: false }),
    /**
     * The deferred runner stand-in: begins the real guard, fires `onNode`
     * for the first node (live-status boundary semantics), then parks the
     * outcome until the test resolves/rejects it.
     */
    runPipeline: (
      input: PipelineRunInput,
      options: PipelineRunOptions,
    ): Promise<PipelineRunResult> => {
      h.runCalls += 1
      options.guard?.begin()
      const first = 'order' in input ? input.nodes[0] : null
      if (first === null) throw new Error('test expects a compiled plan')
      options.onNode?.(first.nodeId)
      return new Promise<PipelineRunResult>((resolve, reject) => {
        h.resolveRun = resolve
        h.rejectRun = reject
      })
    },
  },
}))

/** The SQL-pane recording stub: the output-jump seam, made observable. */
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
    { nodeId: 'customers', relation: 'customers', rowCount: 5 },
    { nodeId: 'renamed', relation: 'renamed', rowCount: 5 },
    { nodeId: 'sg_only', relation: 'sg_only', rowCount: 2 },
    { nodeId: 'by_country', relation: 'by_country', rowCount: 1 },
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
})

describe('pipeline panel — placement and empty states (p-5)', () => {
  it('renders the provisional Pipeline section last, with an honest zero state', async () => {
    render(<App />)
    await openDataset('primary.jsonl')

    // Provisional tail: the section renders after Profile in the DOM.
    const rendered = Array.from(document.querySelectorAll('.workbench-section')).map((section) =>
      section.getAttribute('data-section'),
    )
    expect(rendered[rendered.length - 1]).toBe('pipeline')
    expect(rendered.indexOf('pipeline')).toBeGreaterThan(rendered.indexOf('profile'))

    // The shell owns the managed disclosure; the body is the panel.
    expect(screen.getByTestId('section-toggle-pipeline').getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByTestId('pipeline-panel')).toBeTruthy()
    expect(screen.getByTestId('pipeline-zero-state').textContent).toMatch(/No pipeline open/)

    // Collapse keeps the body mounted (CSS-only collapse invariant).
    await act(async () => {
      fireEvent.click(screen.getByTestId('section-toggle-pipeline'))
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
    h.queue.push(yamlFile('pipeline-pin.yaml', RESERVED_YAML))
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-open'))
    })

    const alert = await screen.findByTestId('pipeline-invalid')
    expect(alert.getAttribute('role')).toBe('alert')
    // The reserved-class refusal names the class, value-free.
    expect(alert.textContent).toContain('reserved')
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

  it('runs serialized with live per-node status, completes with counts, and jumps the output to the SQL pane', async () => {
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

    // Output → the EXISTING result surface: the exact quoted statement
    // rides the SQL pane's runRequest seam (no new grid pathway).
    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-view'))
    })
    expect(screen.getByTestId('sql-request-record').textContent).toBe('SELECT * FROM "by_country"')
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
        nodes: [{ nodeId: 'customers', relation: 'customers', rowCount: 5 }],
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
    // Only TERMINAL relations are viewable (outputs jump; intermediate
    // partial relations do not) — and the only output here never
    // materialized, so nothing is viewable after this failure.
    expect(screen.queryByTestId('pipeline-view')).toBeNull()
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

    // The refusal class (unreachable for a compiler-produced plan with
    // pre-bound sources) still renders honestly: fixed class text, named
    // node, nothing fabricated.
    await act(async () => {
      h.rejectRun?.(new PipelineRunRefusalError('missing-source', 'customers'))
    })
    const refused = screen.getByTestId('pipeline-run-failed')
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
    const { result } = renderHook(() => usePipelineSession({ session: stubSession() }))

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
        nodes: [{ nodeId: 'customers', relation: 'customers', rowCount: 5 }],
        nextNodeId: 'renamed',
      })
    })
    expect(result.current.runState.kind).toBe('canceled')
  })
})
