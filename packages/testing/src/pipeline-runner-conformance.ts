// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pipeline-runner conformance suite (p-3).
 *
 * A dedicated suite (kept out of the generic data-engine conformance suite so
 * engines are not forced to grow a pipeline surface): it is parameterized
 * over a `PipelineRunnerConformanceSubject` whose runner is the engine's
 * pipeline-runner client. The suite owns the scenarios; an engine adapter
 * supplies the runner and stages the fixed source fixture.
 *
 * Scenarios pinned:
 *
 * 1. `pipeline-success` — a 3-node pipeline (source → transform → sql)
 *    materializes in topological order, the final relation's rows are
 *    readable, and a re-run recreates rather than appends (idempotent).
 * 2. `pipeline-mid-dag-failure` — a failing middle node raises a typed,
 *    value-free, node-attributed failure and leaves the named prefix intact;
 *    a repaired pipeline re-runs cleanly.
 * 3. `pipeline-cancel` — invalidating the generation guard at a node boundary
 *    yields a `canceled` outcome with the named partial state and stops
 *    sending further nodes.
 * 4. `pipeline-unknown-node-refusal` — a source binding for a node that is not
 *    in the pipeline is refused before any execution.
 * 5. `pipeline-hostile-sql-refusal` — a side-effect verbatim SQL node is
 *    refused before any engine call (the p-2 classifier gate) and the runner
 *    stays usable.
 * 6. `pipeline-relation-handle` — a materialized pipeline relation registers
 *    as a grid-addressable handle (its schema and row count resolve through
 *    the ordinary registry ops); a missing relation fails value-free.
 *
 * The fixture the subject stages must be the canonical 5-row customer dataset
 * (`customer_id` 1..5, `country` SG/US/SG/DE/US) so the pinned expectations
 * below hold. No dataset values are logged: the suite reports counts/ids only
 * and the failure detail may quote the suite's own synthetic expectations.
 */
import type { PipelineV1 } from '@assay/pipeline'

/** The file-source seam, structural (a `FileSystemFileHandle` satisfies it). */
export interface PipelineRunnerConformanceSource {
  readonly name: string
  getFile(): Promise<unknown>
}

/** A structural generation guard the suite can invalidate. */
export interface PipelineRunnerConformanceGuard {
  invalidate(): void
}

export interface PipelineRunnerConformanceNodeResult {
  readonly nodeId: string
  readonly relation: string
  readonly rowCount: number
}

/** Opaque handle to a dataset the runner registered from a session relation. */
export interface PipelineRunnerConformanceTableHandle {
  readonly kind: 'table'
  readonly id: string
}

export type PipelineRunnerConformanceOutcome =
  | {
      readonly status: 'completed'
      readonly nodes: readonly PipelineRunnerConformanceNodeResult[]
    }
  | {
      readonly status: 'canceled'
      readonly nodes: readonly PipelineRunnerConformanceNodeResult[]
      readonly nextNodeId: string | null
    }

export interface PipelineRunnerConformanceRunOptions {
  readonly sources?: readonly {
    readonly nodeId: string
    readonly source: PipelineRunnerConformanceSource
  }[]
  readonly guard?: PipelineRunnerConformanceGuard
  readonly onNode?: (nodeId: string) => void
}

/** The runner surface the suite drives (the engine client's `runPipeline`). */
export interface PipelineRunnerConformanceRunner {
  runPipeline(
    pipeline: PipelineV1,
    options: PipelineRunnerConformanceRunOptions,
  ): Promise<PipelineRunnerConformanceOutcome>
  /** One relation column as rendered text (NULL as `null`), in row order. */
  readColumn(relation: string, column: string): Promise<readonly (string | null)[]>
  /**
   * Register an EXISTING session relation (a materialized pipeline node) as a
   * grid-addressable table handle (p2-1 (b)). A missing relation rejects with
   * the engine's operation category, value-free.
   */
  registerRelation(relation: string): Promise<PipelineRunnerConformanceTableHandle>
  /** Column name/type pairs of a registered handle, as the engine reports them. */
  schema(
    handle: PipelineRunnerConformanceTableHandle,
  ): Promise<readonly { readonly name: string; readonly type: string }[]>
  /** Total row count of a registered handle. */
  rowCount(handle: PipelineRunnerConformanceTableHandle): Promise<number>
}

export interface PipelineRunnerConformanceSubject {
  readonly name: string
  /** A fresh runner (the harness binds a fresh engine client). */
  createRunner(): PipelineRunnerConformanceRunner
  /** Dispose a runner after a scenario (terminal, idempotent). */
  dispose(runner: PipelineRunnerConformanceRunner): Promise<void>
  /** Stage the canonical 5-row customer dataset. */
  stageSource(): Promise<PipelineRunnerConformanceSource>
  /** A fresh generation guard the suite can invalidate. */
  createGuard(): PipelineRunnerConformanceGuard
  /** Error classification: refusal-before-execution vs node failure. */
  readonly errors: {
    refusal(error: unknown): boolean
    failure(error: unknown): boolean
    failureNodeId(error: unknown): string | null
    failurePartial(error: unknown): readonly string[]
    /** The engine's operation-error class (unknown handle/relation/format). */
    operation(error: unknown): boolean
  }
}

/** Stable scenario identifiers (each runs independently, fresh runner). */
export const pipelineRunnerConformanceScenarioNames = [
  'pipeline-success',
  'pipeline-mid-dag-failure',
  'pipeline-cancel',
  'pipeline-unknown-node-refusal',
  'pipeline-hostile-sql-refusal',
  'pipeline-relation-handle',
] as const

export type PipelineRunnerConformanceScenarioName =
  (typeof pipelineRunnerConformanceScenarioNames)[number]

export interface PipelineRunnerConformanceScenarioResult {
  readonly name: PipelineRunnerConformanceScenarioName
  readonly passed: boolean
  readonly detail: string
  readonly facts: Readonly<Record<string, string | number | boolean>>
}

export interface PipelineRunnerConformanceReport {
  readonly subject: string
  readonly results: readonly PipelineRunnerConformanceScenarioResult[]
  readonly allPassed: boolean
}

// ---- The pinned pipelines + expectations ----

/** source → filter country = SG → sql projection, in topological order. */
function happyPipeline(): PipelineV1 {
  return {
    version: 1,
    pipeline: 'conformance-happy',
    nodes: [
      {
        id: 'customers',
        type: 'source',
        source: { kind: 'file' },
      },
      {
        id: 'sg',
        type: 'transform',
        inputs: ['customers'],
        operation: {
          operation: 'filter',
          args: { predicates: [{ column: 'country', operator: 'equals', value: 'SG' }] },
        },
      },
      {
        id: 'out',
        type: 'sql',
        inputs: ['sg'],
        sql: 'SELECT customer_id FROM sg ORDER BY customer_id',
      },
    ],
  }
}

const HAPPY_NODE_IDS = ['customers', 'sg', 'out'] as const
const HAPPY_ROW_COUNTS = [5, 2, 2] as const
const HAPPY_FINAL_IDS = ['1', '3'] as const

/** A pipeline whose middle node binds a nonexistent column. */
function brokenPipeline(): PipelineV1 {
  return {
    version: 1,
    pipeline: 'conformance-broken',
    nodes: [
      { id: 'customers', type: 'source', source: { kind: 'file' } },
      {
        id: 'broken',
        type: 'transform',
        inputs: ['customers'],
        operation: { operation: 'select-columns', args: { columns: ['no_such_column'] } },
      },
      { id: 'out', type: 'sql', inputs: ['broken'], sql: 'SELECT 1 AS value' },
    ],
  }
}

/** The repaired pipeline (same ids, valid middle node). */
function repairedPipeline(): PipelineV1 {
  return {
    version: 1,
    pipeline: 'conformance-repaired',
    nodes: [
      { id: 'customers', type: 'source', source: { kind: 'file' } },
      {
        id: 'broken',
        type: 'transform',
        inputs: ['customers'],
        operation: { operation: 'select-columns', args: { columns: ['customer_id'] } },
      },
      {
        id: 'out',
        type: 'sql',
        inputs: ['broken'],
        sql: 'SELECT customer_id FROM broken ORDER BY customer_id',
      },
    ],
  }
}

/** A pipeline smuggling a side-effect statement through a `sql` node. */
function hostilePipeline(): PipelineV1 {
  return {
    version: 1,
    pipeline: 'conformance-hostile',
    nodes: [{ id: 'out', type: 'sql', inputs: [], sql: 'DROP TABLE customers' }],
  }
}

function fail(message: string): never {
  throw new Error(message)
}

function expectCondition(condition: boolean, message: string): void {
  if (!condition) fail(message)
}

function expectEqual(actual: unknown, expected: unknown, what: string): void {
  if (actual !== expected) {
    fail(`${what}: expected ${String(expected)}, got ${String(actual)}`)
  }
}

function expectDeepEqual(actual: unknown, expected: unknown, what: string): void {
  const actualJson = JSON.stringify(actual)
  const expectedJson = JSON.stringify(expected)
  if (actualJson !== expectedJson) {
    fail(`${what}: expected ${expectedJson}, got ${actualJson}`)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  return null
}

// ---- Scenarios ----

type PipelineRunnerConformanceScenario = (
  subject: PipelineRunnerConformanceSubject,
) => Promise<Record<string, string | number | boolean>>

const scenarios: Record<PipelineRunnerConformanceScenarioName, PipelineRunnerConformanceScenario> =
  {
    'pipeline-success': async (subject) => {
      const runner = subject.createRunner()
      try {
        const source = await subject.stageSource()
        const first = await runner.runPipeline(happyPipeline(), {
          sources: [{ nodeId: 'customers', source }],
        })
        expectCondition(
          first.status === 'completed',
          `the happy pipeline must complete (got ${first.status})`,
        )
        if (first.status !== 'completed') fail('unreachable')
        expectCondition(first.nodes.length === 3, 'the happy pipeline must materialize three nodes')
        expectDeepEqual(
          first.nodes.map((node) => node.nodeId),
          HAPPY_NODE_IDS,
          'node order',
        )
        expectDeepEqual(
          first.nodes.map((node) => node.rowCount),
          HAPPY_ROW_COUNTS,
          'node row counts',
        )
        const ids = await runner.readColumn('out', 'customer_id')
        expectDeepEqual(ids, HAPPY_FINAL_IDS, 'final relation rows')

        // Idempotent re-run: the same relations are recreated, never appended.
        const second = await runner.runPipeline(happyPipeline(), {
          sources: [{ nodeId: 'customers', source }],
        })
        expectCondition(second.status === 'completed', 'the re-run must complete')
        if (second.status !== 'completed') fail('unreachable')
        expectDeepEqual(
          second.nodes.map((node) => node.rowCount),
          HAPPY_ROW_COUNTS,
          're-run row counts (idempotent)',
        )
        expectDeepEqual(await runner.readColumn('out', 'customer_id'), ids, 're-run rows')

        return { nodes: first.nodes.length, finalRows: ids.length, reRunIdempotent: true }
      } finally {
        await subject.dispose(runner)
      }
    },

    'pipeline-mid-dag-failure': async (subject) => {
      const runner = subject.createRunner()
      try {
        const source = await subject.stageSource()
        const error = await rejectionOf(
          runner.runPipeline(brokenPipeline(), { sources: [{ nodeId: 'customers', source }] }),
        )
        expectCondition(error !== null, 'the broken pipeline must fail')
        expectCondition(
          subject.errors.failure(error),
          `a mid-DAG failure must be the typed failure class (got: ${errorMessage(error)})`,
        )
        expectEqual(subject.errors.failureNodeId(error), 'broken', 'the failing node id')
        expectDeepEqual(subject.errors.failurePartial(error), ['customers'], 'named partial state')
        expectCondition(
          errorMessage(error).length > 0 && !errorMessage(error).includes('customers'),
          'the failure message must be value-free',
        )

        // Clean re-run with the repaired pipeline.
        const repaired = await runner.runPipeline(repairedPipeline(), {
          sources: [{ nodeId: 'customers', source }],
        })
        expectCondition(repaired.status === 'completed', 'the repaired re-run must complete')
        const rows = await runner.readColumn('out', 'customer_id')
        expectDeepEqual(rows, ['1', '2', '3', '4', '5'], 'repaired relation rows')
        return { failingNode: 'broken', partialNodes: 1, reRunRows: rows.length }
      } finally {
        await subject.dispose(runner)
      }
    },

    'pipeline-cancel': async (subject) => {
      const runner = subject.createRunner()
      try {
        const source = await subject.stageSource()
        const guard = subject.createGuard()
        const visited: string[] = []
        const outcome = await runner.runPipeline(happyPipeline(), {
          sources: [{ nodeId: 'customers', source }],
          guard,
          onNode: (nodeId) => {
            visited.push(nodeId)
            if (nodeId === 'sg') guard.invalidate()
          },
        })
        expectCondition(
          outcome.status === 'canceled',
          `an invalidated guard must yield a canceled outcome (got ${outcome.status})`,
        )
        if (outcome.status !== 'canceled') fail('unreachable')
        expectDeepEqual(
          outcome.nodes.map((node) => node.nodeId),
          ['customers'],
          'canceled partial state',
        )
        expectEqual(outcome.nextNodeId, 'sg', 'the unexecuted node')
        expectDeepEqual(visited, ['customers', 'sg'], 'onNode boundaries before cancellation')
        return {
          canceledPartialNodes: outcome.nodes.length,
          nextNodeId: outcome.nextNodeId ?? 'none',
        }
      } finally {
        await subject.dispose(runner)
      }
    },

    'pipeline-unknown-node-refusal': async (subject) => {
      const runner = subject.createRunner()
      try {
        const source = await subject.stageSource()
        const error = await rejectionOf(
          runner.runPipeline(happyPipeline(), {
            sources: [
              { nodeId: 'ghost', source },
              { nodeId: 'customers', source },
            ],
          }),
        )
        expectCondition(error !== null, 'an unknown source node must be refused')
        expectCondition(
          subject.errors.refusal(error),
          `an unknown node must be the typed refusal class (got: ${errorMessage(error)})`,
        )
        return { refused: true }
      } finally {
        await subject.dispose(runner)
      }
    },

    'pipeline-hostile-sql-refusal': async (subject) => {
      const runner = subject.createRunner()
      try {
        const error = await rejectionOf(runner.runPipeline(hostilePipeline(), {}))
        expectCondition(error !== null, 'hostile SQL must be refused')
        expectCondition(
          subject.errors.refusal(error),
          `hostile SQL must be the typed refusal class (got: ${errorMessage(error)})`,
        )
        // The refusal happened before execution: the engine is still usable.
        const source = await subject.stageSource()
        const ok = await runner.runPipeline(happyPipeline(), {
          sources: [{ nodeId: 'customers', source }],
        })
        expectCondition(ok.status === 'completed', 'the engine must remain usable after a refusal')
        return { refused: true, reusableAfterRefusal: true }
      } finally {
        await subject.dispose(runner)
      }
    },

    'pipeline-relation-handle': async (subject) => {
      const runner = subject.createRunner()
      try {
        // A real run materializes the relations the handle op addresses.
        const source = await subject.stageSource()
        const outcome = await runner.runPipeline(happyPipeline(), {
          sources: [{ nodeId: 'customers', source }],
        })
        expectCondition(
          outcome.status === 'completed',
          `the happy pipeline must complete before opening a handle (got ${outcome.status})`,
        )

        const handle = await runner.registerRelation('out')
        expectEqual(handle.kind, 'table', 'the handle kind')
        expectCondition(handle.id.length > 0, 'the handle id must be non-empty')
        const columns = await runner.schema(handle)
        expectCondition(
          columns.some((column) => column.name === 'customer_id'),
          'the handle schema must expose the projected customer_id column',
        )
        expectEqual(await runner.rowCount(handle), 2, 'the handle row count')
        // The handle is now grid-addressable: reading a column through the
        // handle's relation yields the same pinned rows as the run.
        expectDeepEqual(
          await runner.readColumn('out', 'customer_id'),
          HAPPY_FINAL_IDS,
          'the handle relation rows',
        )

        // A missing relation rejects with the classified operation error, and
        // the message never names the relation (value-free, ADR 0025).
        const error = await rejectionOf(runner.registerRelation('no_such_relation_xyz'))
        expectCondition(error !== null, 'an unknown relation must be refused')
        expectCondition(
          subject.errors.operation(error),
          `an unknown relation must be the operation-error class (got: ${errorMessage(error)})`,
        )
        expectCondition(
          !errorMessage(error).includes('no_such_relation_xyz'),
          'the failure message must be value-free',
        )
        return { columns: columns.length, rowCount: 2, unknownRelationRefused: true }
      } finally {
        await subject.dispose(runner)
      }
    },
  }

/** Run the named scenarios (default all) against `subject`. */
export async function runPipelineRunnerConformanceScenarios(
  subject: PipelineRunnerConformanceSubject,
  names?: readonly PipelineRunnerConformanceScenarioName[],
): Promise<PipelineRunnerConformanceReport> {
  const requested = names ?? pipelineRunnerConformanceScenarioNames
  const results: PipelineRunnerConformanceScenarioResult[] = []
  for (const name of requested) {
    const scenario = scenarios[name]
    if (scenario === undefined) {
      results.push({ name, passed: false, detail: `unknown scenario: ${name}`, facts: {} })
      continue
    }
    try {
      const facts = await scenario(subject)
      results.push({ name, passed: true, detail: 'passed', facts })
    } catch (error) {
      results.push({ name, passed: false, detail: errorMessage(error), facts: {} })
    }
  }
  return {
    subject: subject.name,
    results,
    allPassed: results.every((result) => result.passed),
  }
}

/** Run one scenario (see {@link runPipelineRunnerConformanceScenarios}). */
export async function runPipelineRunnerConformanceScenario(
  subject: PipelineRunnerConformanceSubject,
  name: PipelineRunnerConformanceScenarioName,
): Promise<PipelineRunnerConformanceScenarioResult> {
  const report = await runPipelineRunnerConformanceScenarios(subject, [name])
  return report.results[0]!
}
