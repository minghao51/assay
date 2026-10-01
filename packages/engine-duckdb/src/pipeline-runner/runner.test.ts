// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DuckDBInstance } from '@duckdb/node-api'
import { compilePipeline } from '@assay/pipeline'
import type { PipelineCompilePlan, PipelineV1 } from '@assay/pipeline'
import { PipelineRunError, PipelineRunRefusalError } from './errors.js'
import { PipelineRunGuard } from './guard.js'
import { executePipeline } from './runner.js'
import type { PipelineRunEngineOps, PipelineRunSourceFile } from './runner.js'

/**
 * Pure runner tests (p-3): orchestration, the boundary gates, cancellation,
 * and mid-DAG partial state — all against a fake ops adapter, so no engine is
 * involved. The real engine binding is pinned by the executor + client tests
 * and the e2e journey.
 */

const SOURCE_FILE: PipelineRunSourceFile = {
  name: 'customers.parquet',
  getFile: async () => new File([new Uint8Array([1])], 'customers.parquet'),
}

function testPipeline(): PipelineV1 {
  return {
    version: 1,
    pipeline: 'test',
    nodes: [
      { id: 'customers', type: 'source', source: { kind: 'file' } },
      {
        id: 'sg',
        type: 'transform',
        inputs: ['customers'],
        operation: {
          operation: 'filter',
          args: { predicates: [{ column: 'country', operator: 'equals', value: 'SG' }] },
        },
      },
      { id: 'out', type: 'sql', inputs: ['sg'], sql: 'SELECT customer_id FROM sg' },
    ],
  }
}

function sourceOptions(): readonly { nodeId: string; source: PipelineRunSourceFile }[] {
  return [{ nodeId: 'customers', source: SOURCE_FILE }]
}

class FakeOps implements PipelineRunEngineOps {
  readonly calls: string[] = []
  failAt: string | null = null
  onRegister: (() => void) | null = null

  async registerSource(relation: string, source: PipelineRunSourceFile): Promise<number> {
    // The fake never reads the binding; referenced so the parameter is used.
    void source
    this.calls.push(`source:${relation}`)
    this.onRegister?.()
    if (this.failAt === `source:${relation}`) throw new Error('engine failure')
    return 5
  }

  async materialize(relation: string, sql: string): Promise<number> {
    this.calls.push(`materialize:${relation}:${sql}`)
    if (this.failAt === `materialize:${relation}`) throw new Error('engine failure')
    return relation === 'sg' ? 2 : 2
  }
}

describe('executePipeline — success', () => {
  it('materializes every node in topological order and reports relations + counts', async () => {
    const ops = new FakeOps()
    const result = await executePipeline(testPipeline(), { sources: sourceOptions() }, ops)
    expect(result).toEqual({
      status: 'completed',
      nodes: [
        { nodeId: 'customers', relation: 'customers', rowCount: 5 },
        { nodeId: 'sg', relation: 'sg', rowCount: 2 },
        { nodeId: 'out', relation: 'out', rowCount: 2 },
      ],
    })
    expect(ops.calls).toEqual([
      'source:customers',
      'materialize:sg:SELECT\n  *\nFROM "customers"\nWHERE ("country" = \'SG\')',
      'materialize:out:SELECT customer_id FROM sg',
    ])
  })

  it('accepts an already-compiled plan and passes it through unchanged', async () => {
    const ops = new FakeOps()
    const plan: PipelineCompilePlan = {
      order: ['customers', 'out'],
      nodes: [
        {
          nodeId: 'customers',
          kind: 'source',
          relation: 'customers',
          quotedRelation: '"customers"',
          sql: null,
        },
        {
          nodeId: 'out',
          kind: 'sql',
          relation: 'out',
          quotedRelation: '"out"',
          sql: 'SELECT 1 AS value',
        },
      ],
    }
    const result = await executePipeline(plan, { sources: sourceOptions() }, ops)
    expect(result.status).toBe('completed')
    expect(ops.calls).toEqual(['source:customers', 'materialize:out:SELECT 1 AS value'])
  })
})

describe('executePipeline — cancellation (generation guard)', () => {
  it('abandons at the next node boundary and reports the named partial state', async () => {
    const ops = new FakeOps()
    const guard = new PipelineRunGuard()
    ops.onRegister = () => guard.invalidate()
    const result = await executePipeline(testPipeline(), { sources: sourceOptions(), guard }, ops)
    expect(result).toEqual({
      status: 'canceled',
      nodes: [{ nodeId: 'customers', relation: 'customers', rowCount: 5 }],
      nextNodeId: 'sg',
    })
    // The abandoned run stopped sending nodes after the first.
    expect(ops.calls).toEqual(['source:customers'])
  })

  it('calls onNode at each boundary and cancels before the node when the hook invalidates', async () => {
    const ops = new FakeOps()
    const guard = new PipelineRunGuard()
    const visited: string[] = []
    const result = await executePipeline(
      testPipeline(),
      {
        sources: sourceOptions(),
        guard,
        onNode: (nodeId) => {
          visited.push(nodeId)
          if (nodeId === 'sg') guard.invalidate()
        },
      },
      ops,
    )
    expect(visited).toEqual(['customers', 'sg'])
    expect(result).toEqual({
      status: 'canceled',
      nodes: [{ nodeId: 'customers', relation: 'customers', rowCount: 5 }],
      nextNodeId: 'sg',
    })
    expect(ops.calls).toEqual(['source:customers'])
  })

  it('reports a trailing cancellation when the guard flips during the last node', async () => {
    const ops = new FakeOps()
    const guard = new PipelineRunGuard()
    ops.failAt = null
    // Invalidate while the last node is materializing.
    const original = ops.materialize.bind(ops)
    ops.materialize = async (relation, sql) => {
      const value = await original(relation, sql)
      if (relation === 'out') guard.invalidate()
      return value
    }
    const result = await executePipeline(testPipeline(), { sources: sourceOptions(), guard }, ops)
    expect(result).toEqual({
      status: 'canceled',
      nodes: [
        { nodeId: 'customers', relation: 'customers', rowCount: 5 },
        { nodeId: 'sg', relation: 'sg', rowCount: 2 },
        { nodeId: 'out', relation: 'out', rowCount: 2 },
      ],
      nextNodeId: null,
    })
  })
})

describe('executePipeline — mid-DAG failure and clean re-run', () => {
  it('names the failing node, leaves the materialized prefix, and re-runs idempotently', async () => {
    const ops = new FakeOps()
    ops.failAt = 'materialize:sg'
    let error: unknown
    try {
      await executePipeline(testPipeline(), { sources: sourceOptions() }, ops)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(PipelineRunError)
    const failure = error as PipelineRunError
    expect(failure.nodeId).toBe('sg')
    expect(failure.partial).toEqual([{ nodeId: 'customers', relation: 'customers' }])
    expect(ops.calls).toEqual(['source:customers', expect.stringContaining('materialize:sg:')])

    // Clean re-run: the same relations are re-materialized (replace, never append).
    ops.failAt = null
    ops.calls.length = 0
    const result = await executePipeline(testPipeline(), { sources: sourceOptions() }, ops)
    expect(result.status).toBe('completed')
    expect(ops.calls[0]).toBe('source:customers')
    expect(ops.calls.filter((call) => call.startsWith('source:customers'))).toHaveLength(1)
  })
})

describe('executePipeline — refusals before any engine call', () => {
  async function expectRefusal(
    pipelineOrPlan: PipelineV1 | PipelineCompilePlan,
    options: Parameters<typeof executePipeline>[1],
  ): Promise<PipelineRunRefusalError> {
    const ops = new FakeOps()
    let error: unknown
    try {
      await executePipeline(pipelineOrPlan, options, ops)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(PipelineRunRefusalError)
    expect(ops.calls).toEqual([])
    return error as PipelineRunRefusalError
  }

  it('refuses a source binding for an unknown node', async () => {
    const error = await expectRefusal(testPipeline(), {
      sources: [{ nodeId: 'ghost', source: SOURCE_FILE }],
    })
    expect(error.reason).toBe('unknown-source')
    expect(error.nodeId).toBe('ghost')
  })

  it('refuses a source node with no binding', async () => {
    const error = await expectRefusal(testPipeline(), { sources: [] })
    expect(error.reason).toBe('missing-source')
  })

  it('refuses a duplicate source binding', async () => {
    const error = await expectRefusal(testPipeline(), {
      sources: [
        { nodeId: 'customers', source: SOURCE_FILE },
        { nodeId: 'customers', source: SOURCE_FILE },
      ],
    })
    expect(error.reason).toBe('duplicate-source')
  })

  it('refuses an internally inconsistent plan (unknown node)', async () => {
    const plan: PipelineCompilePlan = {
      order: ['customers', 'out'],
      nodes: [
        {
          nodeId: 'customers',
          kind: 'source',
          relation: 'customers',
          quotedRelation: '"customers"',
          sql: null,
        },
        {
          nodeId: 'other',
          kind: 'sql',
          relation: 'other',
          quotedRelation: '"other"',
          sql: 'SELECT 1',
        },
      ],
    }
    const error = await expectRefusal(plan, { sources: sourceOptions() })
    expect(error.reason).toBe('invalid-plan')
  })

  it('refuses a plan whose node relation uses the reserved assay_ namespace', async () => {
    // Pass a compiled plan directly: the IR path now refuses a reserved node
    // id earlier (p2-1 (i) enforces it in `validatePipeline`, so
    // `compilePipeline` fails first with `not-runnable`). The runner's own
    // gate still guards a programmatic/lower-level plan input.
    const plan: PipelineCompilePlan = {
      order: ['assay_customers', 'out'],
      nodes: [
        {
          nodeId: 'assay_customers',
          kind: 'source',
          relation: 'assay_customers',
          quotedRelation: '"assay_customers"',
          sql: null,
        },
        {
          nodeId: 'out',
          kind: 'sql',
          relation: 'out',
          quotedRelation: '"out"',
          sql: 'SELECT 1 AS value',
        },
      ],
    }
    const error = await expectRefusal(plan, {
      sources: [{ nodeId: 'assay_customers', source: SOURCE_FILE }],
    })
    expect(error.reason).toBe('forbidden-relation')
  })

  it('refuses a reserved node id through the IR path at compile (p2-1 (i))', async () => {
    const reserved: PipelineV1 = {
      version: 1,
      pipeline: 'reserved',
      nodes: [
        { id: 'assay_customers', type: 'source', source: { kind: 'file' } },
        { id: 'out', type: 'sql', inputs: ['assay_customers'], sql: 'SELECT 1 AS value' },
      ],
    }
    const error = await expectRefusal(reserved, {
      sources: [{ nodeId: 'assay_customers', source: SOURCE_FILE }],
    })
    // `validatePipeline` (now enforcing the parse-only reserved rule on
    // programmatic ASTs) makes `compilePipeline` refuse the IR before the
    // runner's reserved-relation gate is reached.
    expect(error.reason).toBe('not-runnable')
  })

  it('refuses verbatim SQL that the p-2 classifier rejects (forged plan kind)', async () => {
    const plan: PipelineCompilePlan = {
      order: ['out'],
      nodes: [
        {
          nodeId: 'out',
          kind: 'sql',
          relation: 'out',
          quotedRelation: '"out"',
          sql: 'DROP TABLE customers',
        },
      ],
    }
    const error = await expectRefusal(plan, {})
    expect(error.reason).toBe('forbidden-sql')
  })

  it('refuses an IR whose DAG/compilation is invalid', async () => {
    const broken: PipelineV1 = {
      version: 1,
      pipeline: 'broken',
      nodes: [{ id: 'out', type: 'sql', inputs: ['missing'], sql: 'SELECT 1 AS value' }],
    }
    const error = await expectRefusal(broken, {})
    expect(error.reason).toBe('not-runnable')
  })
})

/**
 * Real-engine pins for p2-3 (additive, test-only): execute the compiler's NEW
 * op SQL and its table/export statements on the real native `@duckdb/node-api`
 * engine. The engine source is untouched — these tests bind the compiled
 * statements directly to a connection.
 */
describe('executePipeline — p2-3 compiled statements on the real engine (node-api)', () => {
  it('runs the compiled join/aggregate/window statements and reads the result', async () => {
    const instance = await DuckDBInstance.create(':memory:')
    const conn = await instance.connect()
    await conn.run('CREATE TABLE customers (customer_id INTEGER, country VARCHAR)')
    await conn.run("INSERT INTO customers VALUES (1, 'SG'), (2, 'SG'), (3, 'US')")
    await conn.run('CREATE TABLE policies (customer_id INTEGER, premium INTEGER)')
    await conn.run('INSERT INTO policies VALUES (1, 10), (2, 20)')

    const compiled = compilePipeline({
      version: 1,
      pipeline: 'engine-pins',
      nodes: [
        { id: 'customers', type: 'source', source: { kind: 'file' } },
        { id: 'policies', type: 'source', source: { kind: 'file' } },
        {
          id: 'joined',
          type: 'transform',
          inputs: ['customers', 'policies'],
          operation: {
            operation: 'join',
            args: { left: 'customers', right: 'policies', on: ['customer_id'] },
          },
        },
        {
          id: 'agg',
          type: 'transform',
          materialization: 'table',
          inputs: ['joined'],
          operation: {
            operation: 'aggregate',
            args: {
              group_by: ['country'],
              aggregations: [{ op: 'sum', column: 'premium', as: 'total' }],
            },
          },
        },
        {
          id: 'ranked',
          type: 'transform',
          inputs: ['agg'],
          operation: {
            operation: 'window',
            args: {
              function: 'row_number',
              order_by: [{ column: 'total', direction: 'desc' }],
              as: 'rank',
            },
          },
        },
      ],
    })
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return

    for (const node of compiled.plan.nodes) {
      if (node.statement === null || node.statement === undefined) continue
      await conn.run(node.statement)
    }

    const reader = await conn.runAndReadAll(
      'SELECT country, CAST(total AS INTEGER) AS total, CAST("rank" AS INTEGER) AS rank FROM ranked ORDER BY "rank"',
    )
    expect(reader.getRowObjects()).toEqual([{ country: 'SG', total: 30, rank: 1 }])
  })

  it('runs a compiled export COPY into a temp scratch dir and re-reads it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'assay-p23-export-'))
    const previousCwd = process.cwd()
    try {
      mkdirSync(join(dir, 'assay-exports'), { recursive: true })
      // The compiled destination is relative (the OPFS `assay-exports/`
      // convention); run from the temp scratch dir so nothing lands in the repo.
      process.chdir(dir)
      const instance = await DuckDBInstance.create(':memory:')
      const conn = await instance.connect()
      await conn.run('CREATE TABLE raw (id INTEGER, label VARCHAR)')
      await conn.run("INSERT INTO raw VALUES (1, 'a'), (2, 'b')")

      const compiled = compilePipeline({
        version: 1,
        pipeline: 'engine-export',
        nodes: [
          { id: 'raw', type: 'source', source: { kind: 'file' } },
          {
            id: 'out',
            type: 'transform',
            materialization: 'export',
            inputs: ['raw'],
            operation: { operation: 'select-columns', args: { columns: ['id', 'label'] } },
          },
        ],
      })
      expect(compiled.ok).toBe(true)
      if (!compiled.ok) return

      const out = compiled.plan.nodes.find((node) => node.nodeId === 'out')
      expect(out?.statementKind).toBe('export')
      await conn.run(out?.statement as string)

      expect(existsSync(join(dir, 'assay-exports', 'assay-export-out.parquet'))).toBe(true)
      const reader = await conn.runAndReadAll(
        "SELECT CAST(count(*) AS INTEGER) AS n FROM read_parquet('assay-exports/assay-export-out.parquet')",
      )
      expect(reader.getRowObjects()).toEqual([{ n: 2 }])
    } finally {
      process.chdir(previousCwd)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
