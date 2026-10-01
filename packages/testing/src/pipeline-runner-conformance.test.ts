// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { compilePipeline } from '@assay/pipeline'
import type { PipelineNode, PipelineV1 } from '@assay/pipeline'
import {
  pipelineRunnerConformanceScenarioNames,
  runPipelineRunnerConformanceScenarios,
} from './pipeline-runner-conformance'
import type {
  PipelineRunnerConformanceGuard,
  PipelineRunnerConformanceNodeResult,
  PipelineRunnerConformanceOutcome,
  PipelineRunnerConformanceRunner,
  PipelineRunnerConformanceRunOptions,
  PipelineRunnerConformanceSource,
  PipelineRunnerConformanceSubject,
  PipelineRunnerConformanceTableHandle,
} from './pipeline-runner-conformance'

/**
 * Suite-logic tests for the p-3 pipeline-runner conformance suite, against a
 * small in-memory compliant runner (the existing conformance-suite pattern:
 * the suite is proven against a fake here and against the real DuckDB engine
 * in the engine's browser harness/e2e journey). The fake compiles with the
 * real p-2 compiler and evaluates the P1 transform operations over scripted
 * rows, so a scenario mismatch is caught rather than papered over.
 */

const COLUMNS = ['customer_id', 'country', 'income', 'signup_date'] as const
const ROWS: readonly (readonly string[])[] = [
  ['1', 'SG', '52000', '2025-01-04'],
  ['2', 'US', '61000', '2025-01-11'],
  ['3', 'SG', 'NULL', '2025-02-02'],
  ['4', 'DE', '48000', '2025-02-19'],
  ['5', 'US', '75000', '2025-03-01'],
]

const FAKE_SOURCE: PipelineRunnerConformanceSource = {
  name: 'customers.parquet',
  getFile: async () => ({ columns: [...COLUMNS], rows: ROWS }),
}

class FakeRefusal extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = 'FakeRefusal'
  }
}

class FakeFailure extends Error {
  constructor(
    readonly nodeId: string,
    readonly partial: readonly string[],
  ) {
    super('the pipeline node could not be materialized')
    this.name = 'FakeFailure'
  }
}

class FakeOperation extends Error {
  constructor() {
    super('the requested relation is not available in this session')
    this.name = 'FakeOperation'
  }
}

interface FakeGuard extends PipelineRunnerConformanceGuard {
  invalidated: boolean
}

interface Relation {
  readonly columns: readonly string[]
  readonly rows: readonly (readonly (string | null)[])[]
}

function rowCountOf(relation: Relation): number {
  return relation.rows.length
}

class FakeRunner implements PipelineRunnerConformanceRunner {
  private readonly relations = new Map<string, Relation>()

  async runPipeline(
    pipeline: PipelineV1,
    options: PipelineRunnerConformanceRunOptions,
  ): Promise<PipelineRunnerConformanceOutcome> {
    const compiled = compilePipeline(pipeline)
    if (!compiled.ok) throw new FakeRefusal('not-runnable')
    const byId = new Map<string, PipelineNode>(pipeline.nodes.map((node) => [node.id, node]))

    const sourceIds = new Set(
      pipeline.nodes.filter((node) => node.type === 'source').map((node) => node.id),
    )
    const bindings = new Map<string, PipelineRunnerConformanceSource>()
    for (const binding of options.sources ?? []) {
      if (!sourceIds.has(binding.nodeId)) throw new FakeRefusal('unknown-source')
      if (bindings.has(binding.nodeId)) throw new FakeRefusal('duplicate-source')
      bindings.set(binding.nodeId, binding.source)
    }
    for (const id of sourceIds) {
      if (!bindings.has(id)) throw new FakeRefusal('missing-source')
    }

    const done: PipelineRunnerConformanceNodeResult[] = []
    for (const nodeId of compiled.plan.order) {
      const node = byId.get(nodeId)
      if (node === undefined) throw new FakeRefusal('invalid-plan')
      if (options.guard !== undefined && (options.guard as FakeGuard).invalidated) {
        return { status: 'canceled', nodes: done, nextNodeId: nodeId }
      }
      options.onNode?.(nodeId)
      if (options.guard !== undefined && (options.guard as FakeGuard).invalidated) {
        return { status: 'canceled', nodes: done, nextNodeId: nodeId }
      }
      const partial = done.map((entry) => entry.nodeId)
      try {
        const relation = await this.materialize(node, bindings)
        this.relations.set(nodeId, relation)
        done.push({ nodeId, relation: nodeId, rowCount: rowCountOf(relation) })
      } catch (error) {
        if (error instanceof FakeRefusal) throw error
        throw new FakeFailure(nodeId, partial)
      }
    }
    return { status: 'completed', nodes: done }
  }

  async readColumn(relation: string, column: string): Promise<readonly (string | null)[]> {
    const found = this.relations.get(relation)
    if (found === undefined) return []
    const index = found.columns.indexOf(column)
    if (index < 0) return []
    return found.rows.map((row) => row[index] ?? null)
  }

  async registerRelation(relation: string): Promise<PipelineRunnerConformanceTableHandle> {
    if (!this.relations.has(relation)) throw new FakeOperation()
    return { kind: 'table', id: `fake-handle-${relation}` }
  }

  async schema(
    handle: PipelineRunnerConformanceTableHandle,
  ): Promise<readonly { readonly name: string; readonly type: string }[]> {
    const relation = handle.id.replace(/^fake-handle-/, '')
    const found = this.relations.get(relation)
    if (found === undefined) throw new FakeOperation()
    return found.columns.map((name) => ({ name, type: 'VARCHAR' }))
  }

  async rowCount(handle: PipelineRunnerConformanceTableHandle): Promise<number> {
    const relation = handle.id.replace(/^fake-handle-/, '')
    const found = this.relations.get(relation)
    if (found === undefined) throw new FakeOperation()
    return rowCountOf(found)
  }

  private async materialize(
    node: PipelineNode,
    bindings: ReadonlyMap<string, PipelineRunnerConformanceSource>,
  ): Promise<Relation> {
    if (node.type === 'source') {
      const source = bindings.get(node.id)
      if (source === undefined) throw new FakeRefusal('missing-source')
      const data = (await source.getFile()) as { columns: string[]; rows: readonly string[][] }
      return { columns: data.columns, rows: data.rows }
    }
    if (node.type === 'transform') {
      const parent = this.requireInput(node.inputs)
      const operation = node.operation.operation
      const args = node.operation.args
      if (operation === 'select-columns') {
        const columns = args.columns
        if (!Array.isArray(columns)) throw new FakeFailure(node.id, [])
        const names = columns.map((column) => String(column))
        // A missing column simulates DuckDB's binder error at view creation.
        for (const name of names) {
          if (!parent.columns.includes(name)) throw new FakeFailure(node.id, [])
        }
        const indexes = names.map((name) => parent.columns.indexOf(name))
        return {
          columns: names,
          rows: parent.rows.map((row) => indexes.map((index) => row[index] ?? null)),
        }
      }
      if (operation === 'filter') {
        const predicates = args.predicates
        if (!Array.isArray(predicates)) throw new FakeFailure(node.id, [])
        const rows = parent.rows.filter((row) =>
          predicates.every((predicate) => {
            const spec = predicate as { column: string; operator: string; value: unknown }
            const index = parent.columns.indexOf(spec.column)
            if (index < 0) throw new FakeFailure(node.id, [])
            return row[index] === String(spec.value)
          }),
        )
        return { columns: parent.columns, rows }
      }
      throw new FakeFailure(node.id, [])
    }
    if (node.type === 'sql') {
      if (node.inputs.length === 0) return { columns: ['value'], rows: [['1']] }
      return this.requireInput(node.inputs)
    }
    throw new FakeRefusal('reserved-node-class')
  }

  private requireInput(inputs: readonly string[]): Relation {
    const input = inputs[0]
    const relation = input === undefined ? undefined : this.relations.get(input)
    if (relation === undefined) throw new FakeFailure(input ?? 'unknown', [])
    return relation
  }
}

function compliantSubject(): PipelineRunnerConformanceSubject {
  const runner = new FakeRunner()
  return {
    name: 'fake-pipeline-runner',
    createRunner: () => runner,
    dispose: async () => {
      // Keep the fake stateless across scenarios: scenarios are independent.
    },
    stageSource: async () => FAKE_SOURCE,
    createGuard: () => {
      const guard: FakeGuard = {
        invalidated: false,
        invalidate() {
          guard.invalidated = true
        },
      }
      return guard
    },
    errors: {
      refusal: (error) => error instanceof FakeRefusal,
      failure: (error) => error instanceof FakeFailure,
      failureNodeId: (error) => (error instanceof FakeFailure ? error.nodeId : null),
      failurePartial: (error) => (error instanceof FakeFailure ? [...error.partial] : []),
      operation: (error) => error instanceof FakeOperation,
    },
  }
}

describe('pipeline-runner conformance suite (fake compliant subject)', () => {
  it('runs every exported scenario against a compliant in-memory runner', async () => {
    const report = await runPipelineRunnerConformanceScenarios(compliantSubject())
    expect(report.results.map((result) => result.name)).toEqual([
      ...pipelineRunnerConformanceScenarioNames,
    ])
    for (const result of report.results) {
      expect(result.passed, `${result.name}: ${result.detail}`).toBe(true)
    }
    expect(report.allPassed).toBe(true)
  })

  it('fails a scenario when the runner violates the contract (mutation check)', async () => {
    const subject = compliantSubject()
    const mutated: PipelineRunnerConformanceSubject = {
      ...subject,
      createRunner: () => {
        const runner = new FakeRunner()
        let call = 0
        return {
          runPipeline: async (pipeline, options) => {
            call += 1
            const outcome = await runner.runPipeline(pipeline, options)
            // Append a duplicate node result on the first run: the success
            // scenario must notice the non-idempotent re-materialization.
            if (outcome.status === 'completed' && call === 1) {
              return { status: 'completed', nodes: [...outcome.nodes, ...outcome.nodes] }
            }
            return outcome
          },
          readColumn: (relation, column) => runner.readColumn(relation, column),
          registerRelation: (relation) => runner.registerRelation(relation),
          schema: (handle) => runner.schema(handle),
          rowCount: (handle) => runner.rowCount(handle),
        }
      },
    }
    const report = await runPipelineRunnerConformanceScenarios(mutated, ['pipeline-success'])
    expect(report.results[0]?.passed).toBe(false)
  })
})
