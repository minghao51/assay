// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { compilePipeline, validatePipeline } from '@assay/pipeline'
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

/** Non-null-aware value read (the fake renders NULL as the string `'NULL'`). */
function isNull(value: string | null | undefined): boolean {
  return value === null || value === undefined || value === 'NULL'
}

/** Evaluate the suite's simple contract AST against a fake relation. */
function evaluateContract(contract: unknown, relation: Relation): number {
  const columns = (
    contract as { columns?: readonly { name?: unknown; required?: unknown; unique?: unknown }[] }
  ).columns
  if (!Array.isArray(columns)) return 0
  let violated = 0
  for (const rule of columns) {
    if (typeof rule.name !== 'string') {
      violated += 1
      continue
    }
    const index = relation.columns.indexOf(rule.name)
    if (index < 0) {
      violated += 1
      continue
    }
    const values = relation.rows.map((row) => row[index] ?? null)
    if (rule.required === true && values.some((value) => isNull(value))) violated += 1
    if (rule.unique === true) {
      const nonNull = values.filter((value) => !isNull(value))
      if (new Set(nonNull).size !== nonNull.length) violated += 1
    }
  }
  return violated
}

/** Compute the three row-diff aspect counts over a key set. */
function computeDiff(
  sideA: Relation,
  sideB: Relation,
  keys: readonly string[],
): { added: number; removed: number; changed: number } {
  const keyIndexA = keys.map((key) => sideA.columns.indexOf(key))
  const keyIndexB = keys.map((key) => sideB.columns.indexOf(key))
  const keyOf = (row: readonly (string | null)[], indexes: readonly number[]): string =>
    indexes.map((index) => (index < 0 ? 'NULL' : (row[index] ?? 'NULL'))).join('\u0000')
  const mapA = new Map(sideA.rows.map((row) => [keyOf(row, keyIndexA), row]))
  const mapB = new Map(sideB.rows.map((row) => [keyOf(row, keyIndexB), row]))
  let added = 0
  let removed = 0
  let changed = 0
  for (const key of mapB.keys()) if (!mapA.has(key)) added += 1
  for (const key of mapA.keys()) if (!mapB.has(key)) removed += 1
  const shared = sideA.columns.filter(
    (column) => !keys.includes(column) && sideB.columns.includes(column),
  )
  for (const [key, rowA] of mapA) {
    const rowB = mapB.get(key)
    if (rowB === undefined) continue
    const differs = shared.some((column) => {
      const valueA = rowA[sideA.columns.indexOf(column)] ?? null
      const valueB = rowB[sideB.columns.indexOf(column)] ?? null
      return valueA !== valueB
    })
    if (differs) changed += 1
  }
  return { added, removed, changed }
}

class FakeRunner implements PipelineRunnerConformanceRunner {
  private readonly relations = new Map<string, Relation>()
  private readonly kinds = new Map<string, 'view' | 'table'>()

  async runPipeline(
    pipeline: PipelineV1,
    options: PipelineRunnerConformanceRunOptions,
  ): Promise<PipelineRunnerConformanceOutcome> {
    const validation = validatePipeline(pipeline)
    if (!validation.ok) throw new FakeRefusal('not-runnable')
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

    // Data-node materialization + gate-binding preconditions (the real
    // runner's pure boundary gates, mirrored for the suite self-test).
    const referenced = new Set<string>()
    for (const node of pipeline.nodes) {
      if (node.type === 'transform' || node.type === 'sql') {
        for (const input of node.inputs) referenced.add(input)
      } else if (node.type === 'validate' || node.type === 'publish') {
        referenced.add(node.input)
        if (node.type === 'publish') for (const gate of node.requires ?? []) referenced.add(gate)
      } else if (node.type === 'diff') {
        referenced.add(node.input)
        referenced.add(node.against)
      }
    }
    for (const node of pipeline.nodes) {
      if (node.type !== 'source' && node.type !== 'transform' && node.type !== 'sql') continue
      const mode = (node as { materialization?: string }).materialization ?? 'view'
      if (mode === 'cache' || mode === 'incremental' || mode === 'publish') {
        throw new FakeRefusal('unsupported-materialization')
      }
      if (mode === 'export' && referenced.has(node.id)) {
        throw new FakeRefusal('export-with-consumers')
      }
    }
    const contracts = new Map<string, unknown>()
    for (const binding of options.contracts ?? []) {
      if (!pipeline.nodes.some((node) => node.id === binding.nodeId && node.type === 'validate')) {
        throw new FakeRefusal('unknown-contract')
      }
      contracts.set(binding.nodeId, binding.contract)
    }
    const diffKeys = new Map<string, readonly string[]>()
    for (const binding of options.diffKeys ?? []) {
      if (!pipeline.nodes.some((node) => node.id === binding.nodeId && node.type === 'diff')) {
        throw new FakeRefusal('unknown-diff-keys')
      }
      diffKeys.set(binding.nodeId, binding.keys)
    }
    for (const node of pipeline.nodes) {
      if (node.type === 'validate' && !contracts.has(node.id))
        throw new FakeRefusal('missing-contract')
      if (node.type === 'diff' && !diffKeys.has(node.id)) throw new FakeRefusal('missing-diff-keys')
    }

    const dataNodes = pipeline.nodes.filter(
      (node) => node.type === 'source' || node.type === 'transform' || node.type === 'sql',
    )
    const compiled = compilePipeline({ ...pipeline, nodes: dataNodes })
    if (!compiled.ok) throw new FakeRefusal('not-runnable')
    const compiledById = new Map(compiled.plan.nodes.map((node) => [node.nodeId, node]))

    const done: PipelineRunnerConformanceNodeResult[] = []
    const succeeded = new Set<string>()
    const rowCounts = new Map<string, number>()
    const requiredByPublish = new Set<string>()
    for (const node of pipeline.nodes) {
      if (node.type === 'publish')
        for (const gate of node.requires ?? []) requiredByPublish.add(gate)
    }

    const order = validation.order
    const gated = (
      gate: 'validation-failed' | 'publish-blocked',
      gatedAt: string,
    ): PipelineRunnerConformanceOutcome => {
      const index = order.indexOf(gatedAt)
      return {
        status: 'gated',
        nodes: done,
        gatedAt,
        gate,
        nextNodeId: index + 1 < order.length ? order[index + 1]! : null,
      }
    }

    for (const nodeId of order) {
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
        if (node.type === 'source' || node.type === 'transform' || node.type === 'sql') {
          if (!compiledById.has(nodeId)) throw new FakeRefusal('not-runnable')
          const relation = await this.materialize(node, bindings)
          const mode = (node as { materialization?: string }).materialization ?? 'view'
          if (mode === 'export') {
            done.push({
              nodeId,
              relation: nodeId,
              rowCount: rowCountOf(relation),
              materialization: 'export',
              exportPath: `assay-exports/assay-pipeline-export-${nodeId}.parquet`,
            })
          } else {
            this.relations.set(nodeId, relation)
            this.kinds.set(nodeId, mode === 'table' ? 'table' : 'view')
            done.push({
              nodeId,
              relation: nodeId,
              rowCount: rowCountOf(relation),
              materialization: mode,
            })
          }
        } else if (node.type === 'validate') {
          const relation = this.requireRelation(node.input)
          const violatedRules = evaluateContract(contracts.get(nodeId), relation)
          const valid = violatedRules === 0
          done.push({
            nodeId,
            relation: node.input,
            rowCount: rowCountOf(relation),
            materialization: 'gate',
            gate: { class: 'validate', valid, violatedRules },
          })
          if (!valid) {
            if (!requiredByPublish.has(nodeId)) return gated('validation-failed', nodeId)
            continue
          }
        } else if (node.type === 'diff') {
          const sideA = this.requireRelation(node.input)
          const sideB = this.requireRelation(node.against)
          const counts = computeDiff(sideA, sideB, [...(diffKeys.get(nodeId) ?? [])])
          done.push({
            nodeId,
            relation: node.input,
            rowCount: rowCountOf(sideA),
            materialization: 'gate',
            gate: { class: 'diff', ...counts },
          })
        } else {
          const blockedGates = (node.requires ?? []).filter((gate) => !succeeded.has(gate))
          done.push({
            nodeId,
            relation: node.input,
            rowCount: rowCounts.get(node.input) ?? 0,
            materialization: 'gate',
            gate: { class: 'publish', blockedGates },
          })
          if (blockedGates.length > 0) return gated('publish-blocked', nodeId)
        }
        succeeded.add(nodeId)
        rowCounts.set(nodeId, done[done.length - 1]?.rowCount ?? 0)
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

  async relationKind(relation: string): Promise<'table' | 'view' | 'missing'> {
    return this.kinds.get(relation) ?? 'missing'
  }

  private requireRelation(relation: string): Relation {
    const found = this.relations.get(relation)
    if (found === undefined) throw new FakeFailure(relation, [])
    return found
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
  return {
    name: 'fake-pipeline-runner',
    // A fresh runner per scenario (the real harness mints a fresh engine
    // client), so relations never leak between scenarios.
    createRunner: () => new FakeRunner(),
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
      refusalReason: (error) => (error instanceof FakeRefusal ? error.reason : null),
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
          relationKind: (relation) => runner.relationKind(relation),
        }
      },
    }
    const report = await runPipelineRunnerConformanceScenarios(mutated, ['pipeline-success'])
    expect(report.results[0]?.passed).toBe(false)
  })
})
