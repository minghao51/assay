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
import type { PipelineRunCompilers, PipelineRunEngineOps, PipelineRunSourceFile } from './runner.js'
import type { EngineValidationPlan, EngineValidationResult } from '../validate-plan-wire.js'
import type { EngineRowDiffPlan, EngineRowDiffResult } from '../diff-plan-wire.js'

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

/** source → filter(SG) → validate(gate) → publish(out, requires gate). */
function gatePipeline(): PipelineV1 {
  return {
    version: 1,
    pipeline: 'gate',
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
      { id: 'gate', type: 'validate', input: 'sg', contract: 'contracts/gate.yaml' },
      { id: 'out', type: 'publish', input: 'sg', requires: ['gate'] },
    ],
  }
}

/** source → filter(SG) → validate(gate); a terminal gate. */
function terminalGatePipeline(): PipelineV1 {
  const pipeline = gatePipeline()
  return {
    ...pipeline,
    pipeline: 'terminal-gate',
    nodes: pipeline.nodes.filter((n) => n.id !== 'out'),
  }
}

/** source → filter(SG) → diff(compare sg against customers). */
function diffPipeline(): PipelineV1 {
  return {
    version: 1,
    pipeline: 'diff',
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
      { id: 'compare', type: 'diff', input: 'sg', against: 'customers' },
    ],
  }
}

/** source → table(SG filter). */
function tablePipeline(): PipelineV1 {
  return {
    version: 1,
    pipeline: 'table',
    nodes: [
      { id: 'customers', type: 'source', source: { kind: 'file' } },
      {
        id: 'sg',
        type: 'transform',
        materialization: 'table',
        inputs: ['customers'],
        operation: {
          operation: 'filter',
          args: { predicates: [{ column: 'country', operator: 'equals', value: 'SG' }] },
        },
      },
    ],
  }
}

/** source → export(out). */
function exportPipeline(): PipelineV1 {
  return {
    version: 1,
    pipeline: 'export',
    nodes: [
      { id: 'customers', type: 'source', source: { kind: 'file' } },
      {
        id: 'out',
        type: 'sql',
        materialization: 'export',
        inputs: ['customers'],
        sql: 'SELECT customer_id FROM customers',
      },
    ],
  }
}

/** An unsupported materialization mode on a data node. */
function unsupportedModePipeline(mode: 'publish' | 'cache' | 'incremental'): PipelineV1 {
  return {
    version: 1,
    pipeline: `mode-${mode}`,
    nodes: [
      { id: 'customers', type: 'source', source: { kind: 'file' } },
      {
        id: 'out',
        type: 'sql',
        materialization: mode,
        inputs: ['customers'],
        sql: 'SELECT customer_id FROM customers',
      },
    ],
  }
}

/** An export node consumed by a second node. */
function exportWithConsumersPipeline(): PipelineV1 {
  return {
    version: 1,
    pipeline: 'export-consumed',
    nodes: [
      { id: 'customers', type: 'source', source: { kind: 'file' } },
      {
        id: 'out',
        type: 'sql',
        materialization: 'export',
        inputs: ['customers'],
        sql: 'SELECT customer_id FROM customers',
      },
      { id: 'downstream', type: 'sql', inputs: ['out'], sql: 'SELECT customer_id FROM out' },
    ],
  }
}

class FakeOps implements PipelineRunEngineOps {
  readonly calls: string[] = []
  readonly modes: Record<string, string> = {}
  failAt: string | null = null
  onRegister: (() => void) | null = null
  validationValid = true
  diffResult: EngineRowDiffResult = {
    rowCountA: 2,
    rowCountB: 5,
    aspects: [
      { aspect: 'added', count: 3, samples: [] },
      { aspect: 'removed', count: 0, samples: [] },
      { aspect: 'changed', count: 0, samples: [] },
    ],
  }

  async registerSource(relation: string, source: PipelineRunSourceFile): Promise<number> {
    // The fake never reads the binding; referenced so the parameter is used.
    void source
    this.calls.push(`source:${relation}`)
    this.onRegister?.()
    if (this.failAt === `source:${relation}`) throw new Error('engine failure')
    return 5
  }

  async materialize(
    relation: string,
    sql: string,
    materialization: 'view' | 'ephemeral' | 'table',
  ): Promise<number> {
    this.calls.push(`materialize:${relation}:${sql}`)
    this.modes[relation] = materialization
    if (this.failAt === `materialize:${relation}`) throw new Error('engine failure')
    return relation === 'sg' ? 2 : 2
  }

  async exportRelation(
    relation: string,
    sql: string,
    path: string,
  ): Promise<{ path: string; rowCount: number; bytes: number }> {
    this.calls.push(`export:${relation}:${sql}`)
    return { path, rowCount: 5, bytes: 3 }
  }

  async schemaOf(): Promise<readonly { readonly name: string; readonly type: string }[]> {
    return [{ name: 'customer_id', type: 'BIGINT' }]
  }

  async validate(relation: string): Promise<EngineValidationResult> {
    this.calls.push(`validate:${relation}`)
    return {
      valid: this.validationValid,
      rowCount: 2,
      rules: [
        {
          ruleId: 'columns[0].required',
          outcome: 'row-samples',
          failCount: this.validationValid ? 0 : 1,
          failPercent: 0,
          sampleFailures: [],
        },
      ],
    }
  }

  async diff(inputRelation: string, againstRelation: string): Promise<EngineRowDiffResult> {
    this.calls.push(`diff:${inputRelation}:${againstRelation}`)
    return this.diffResult
  }
}

const PASS_THROUGH_COMPILERS: PipelineRunCompilers = {
  validate: () => ({ ok: true, plan: {} as EngineValidationPlan }),
  diff: () => ({ ok: true, plan: {} as EngineRowDiffPlan }),
}

describe('executePipeline — success', () => {
  it('materializes every node in topological order and reports relations + counts', async () => {
    const ops = new FakeOps()
    const result = await executePipeline(testPipeline(), { sources: sourceOptions() }, ops)
    expect(result).toEqual({
      status: 'completed',
      nodes: [
        { nodeId: 'customers', relation: 'customers', rowCount: 5, materialization: 'source' },
        { nodeId: 'sg', relation: 'sg', rowCount: 2, materialization: 'view' },
        { nodeId: 'out', relation: 'out', rowCount: 2, materialization: 'view' },
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
          materialization: 'view',
          statement: 'CREATE OR REPLACE VIEW "out" AS SELECT 1 AS value',
          statementKind: 'view',
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
      nodes: [
        { nodeId: 'customers', relation: 'customers', rowCount: 5, materialization: 'source' },
      ],
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
      nodes: [
        { nodeId: 'customers', relation: 'customers', rowCount: 5, materialization: 'source' },
      ],
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
    ops.materialize = async (relation, sql, materialization) => {
      const value = await original(relation, sql, materialization)
      if (relation === 'out') guard.invalidate()
      return value
    }
    const result = await executePipeline(testPipeline(), { sources: sourceOptions(), guard }, ops)
    expect(result).toEqual({
      status: 'canceled',
      nodes: [
        { nodeId: 'customers', relation: 'customers', rowCount: 5, materialization: 'source' },
        { nodeId: 'sg', relation: 'sg', rowCount: 2, materialization: 'view' },
        { nodeId: 'out', relation: 'out', rowCount: 2, materialization: 'view' },
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
          materialization: 'view',
          statement: 'CREATE OR REPLACE VIEW "out" AS SELECT 1 AS value',
          statementKind: 'view',
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
          materialization: 'view',
          statement: 'CREATE OR REPLACE VIEW "out" AS DROP TABLE customers',
          statementKind: 'view',
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

describe('executePipeline — p2-4 gates and materialization', () => {
  it('runs a validate node, surfaces its verdict, and completes the publish gate', async () => {
    const ops = new FakeOps()
    ops.validationValid = true
    const result = await executePipeline(
      gatePipeline(),
      {
        sources: sourceOptions(),
        contracts: [{ nodeId: 'gate', contract: { fake: true } }],
        compilers: PASS_THROUGH_COMPILERS,
      },
      ops,
    )
    expect(result.status).toBe('completed')
    if (result.status !== 'completed') return
    const gate = result.nodes.find((node) => node.nodeId === 'gate')
    expect(gate?.materialization).toBe('gate')
    expect(gate?.gate).toEqual({
      class: 'validate',
      input: 'sg',
      valid: true,
      violatedRules: 0,
    })
    const publish = result.nodes.find((node) => node.nodeId === 'out')
    expect(publish?.gate).toEqual({ class: 'publish', input: 'sg', blockedGates: [] })
    expect(ops.calls).toContain('validate:sg')
  })

  it('gates a run at a failing terminal validate node', async () => {
    const ops = new FakeOps()
    ops.validationValid = false
    const result = await executePipeline(
      terminalGatePipeline(),
      {
        sources: sourceOptions(),
        contracts: [{ nodeId: 'gate', contract: {} }],
        compilers: PASS_THROUGH_COMPILERS,
      },
      ops,
    )
    expect(result).toEqual({
      status: 'gated',
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
      ],
      gatedAt: 'gate',
      gate: 'validation-failed',
      nextNodeId: null,
    })
  })

  it('gates a run at a publish whose required validate failed, then completes after the fix', async () => {
    const ops = new FakeOps()
    ops.validationValid = false
    const gatedRun = await executePipeline(
      gatePipeline(),
      {
        sources: sourceOptions(),
        contracts: [{ nodeId: 'gate', contract: {} }],
        compilers: PASS_THROUGH_COMPILERS,
      },
      ops,
    )
    expect(gatedRun.status).toBe('gated')
    if (gatedRun.status !== 'gated') return
    expect(gatedRun.gatedAt).toBe('out')
    expect(gatedRun.gate).toBe('publish-blocked')
    const publish = gatedRun.nodes.find((node) => node.nodeId === 'out')
    expect(publish?.gate).toEqual({ class: 'publish', input: 'sg', blockedGates: ['gate'] })

    // Re-run after fixing the contract: the gate passes, the publish runs.
    ops.validationValid = true
    const completed = await executePipeline(
      gatePipeline(),
      {
        sources: sourceOptions(),
        contracts: [{ nodeId: 'gate', contract: {} }],
        compilers: PASS_THROUGH_COMPILERS,
      },
      ops,
    )
    expect(completed.status).toBe('completed')
    if (completed.status !== 'completed') return
    expect(completed.nodes.find((node) => node.nodeId === 'out')?.gate).toEqual({
      class: 'publish',
      input: 'sg',
      blockedGates: [],
    })
  })

  it('runs a diff node and surfaces its value-free aspect counts', async () => {
    const ops = new FakeOps()
    const result = await executePipeline(
      diffPipeline(),
      {
        sources: sourceOptions(),
        diffKeys: [{ nodeId: 'compare', keys: ['customer_id'] }],
        compilers: PASS_THROUGH_COMPILERS,
      },
      ops,
    )
    expect(result.status).toBe('completed')
    if (result.status !== 'completed') return
    const compare = result.nodes.find((node) => node.nodeId === 'compare')
    expect(compare?.gate).toEqual({
      class: 'diff',
      input: 'sg',
      against: 'customers',
      added: 3,
      removed: 0,
      changed: 0,
    })
    expect(ops.calls).toContain('diff:sg:customers')
  })

  it('materializes table mode through the table op', async () => {
    const ops = new FakeOps()
    const result = await executePipeline(tablePipeline(), { sources: sourceOptions() }, ops)
    expect(result.status).toBe('completed')
    expect(ops.modes['sg']).toBe('table')
  })

  it('exports an export node and returns the value-free artifact path', async () => {
    const ops = new FakeOps()
    const result = await executePipeline(exportPipeline(), { sources: sourceOptions() }, ops)
    expect(result.status).toBe('completed')
    if (result.status !== 'completed') return
    const exported = result.nodes.find((node) => node.nodeId === 'out')
    expect(exported?.materialization).toBe('export')
    expect(exported?.rowCount).toBe(5)
    expect(exported?.exportPath).toBe('assay-exports/assay-pipeline-export-out.parquet')
  })

  it('refuses unsupported materialization modes and export-with-consumers', async () => {
    for (const mode of ['publish', 'cache', 'incremental'] as const) {
      let error: unknown
      try {
        await executePipeline(
          unsupportedModePipeline(mode),
          { sources: sourceOptions() },
          new FakeOps(),
        )
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(PipelineRunRefusalError)
      expect((error as PipelineRunRefusalError).reason).toBe('unsupported-materialization')
    }
    let error: unknown
    try {
      await executePipeline(
        exportWithConsumersPipeline(),
        { sources: sourceOptions() },
        new FakeOps(),
      )
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(PipelineRunRefusalError)
    expect((error as PipelineRunRefusalError).reason).toBe('export-with-consumers')
  })

  it('collects missing contract and diff-key bindings, and rejects misaddressed ones', async () => {
    const missing = await expectRefusalOf(gatePipeline(), { sources: sourceOptions() })
    expect(missing.reason).toBe('missing-contract')
    const unknown = await expectRefusalOf(terminalGatePipeline(), {
      sources: sourceOptions(),
      contracts: [{ nodeId: 'ghost', contract: {} }],
    })
    expect(unknown.reason).toBe('unknown-contract')
    const missingKeys = await expectRefusalOf(diffPipeline(), { sources: sourceOptions() })
    expect(missingKeys.reason).toBe('missing-diff-keys')
  })

  it('refuses a gate node when the host supplies no compiler (gate-unsupported)', async () => {
    const error = await expectRefusalOf(terminalGatePipeline(), {
      sources: sourceOptions(),
      contracts: [{ nodeId: 'gate', contract: {} }],
    })
    expect(error.reason).toBe('gate-unsupported')
  })

  it('refuses a diff node with no compiler and an export node with no export op', async () => {
    const diffError = await expectRefusalOf(diffPipeline(), {
      sources: sourceOptions(),
      diffKeys: [{ nodeId: 'compare', keys: ['customer_id'] }],
    })
    expect(diffError.reason).toBe('gate-unsupported')

    const limitedOps: PipelineRunEngineOps = {
      registerSource: async () => 1,
      materialize: async () => 1,
    }
    let error: unknown
    try {
      await executePipeline(exportPipeline(), { sources: sourceOptions() }, limitedOps)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(PipelineRunRefusalError)
    expect((error as PipelineRunRefusalError).reason).toBe('unsupported-materialization')
  })

  it('refuses a validate gate when the engine validate op is missing', async () => {
    const ops: PipelineRunEngineOps = {
      registerSource: async () => 5,
      materialize: async () => 2,
      schemaOf: async () => [{ name: 'customer_id', type: 'BIGINT' }],
    }
    let error: unknown
    try {
      await executePipeline(
        terminalGatePipeline(),
        {
          sources: sourceOptions(),
          contracts: [{ nodeId: 'gate', contract: {} }],
          compilers: PASS_THROUGH_COMPILERS,
        },
        ops,
      )
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(PipelineRunRefusalError)
    expect((error as PipelineRunRefusalError).reason).toBe('gate-unsupported')
  })

  it('maps a failing host compiler to a node-attributed run error', async () => {
    const validateFailure = await runErrorOf(terminalGatePipeline(), {
      sources: sourceOptions(),
      contracts: [{ nodeId: 'gate', contract: {} }],
      compilers: { validate: () => ({ ok: false }) },
    })
    expect(validateFailure.nodeId).toBe('gate')
    const diffFailure = await runErrorOf(diffPipeline(), {
      sources: sourceOptions(),
      diffKeys: [{ nodeId: 'compare', keys: ['customer_id'] }],
      compilers: { diff: () => ({ ok: false }) },
    })
    expect(diffFailure.nodeId).toBe('compare')
  })

  it('names the next node when a non-trailing validate gate stops the run', async () => {
    const pipeline: PipelineV1 = {
      version: 1,
      pipeline: 'branching-gate',
      nodes: [
        { id: 'a', type: 'source', source: { kind: 'file' } },
        { id: 'gateA', type: 'validate', input: 'a', contract: 'contracts/gate.yaml' },
        { id: 'b', type: 'source', source: { kind: 'file' } },
        { id: 'outB', type: 'sql', inputs: ['b'], sql: 'SELECT 1 AS value' },
      ],
    }
    const ops = new FakeOps()
    ops.validationValid = false
    const result = await executePipeline(
      pipeline,
      {
        sources: [
          { nodeId: 'a', source: SOURCE_FILE },
          { nodeId: 'b', source: SOURCE_FILE },
        ],
        contracts: [{ nodeId: 'gateA', contract: {} }],
        compilers: PASS_THROUGH_COMPILERS,
      },
      ops,
    )
    expect(result.status).toBe('gated')
    if (result.status !== 'gated') return
    expect(result.gatedAt).toBe('gateA')
    expect(result.nextNodeId).toBe('outB')
  })

  it('stops at an unconsumed failing validate before any downstream node executes', async () => {
    // Claim 4: `nextNodeId` naming alone is also satisfied by the defensive
    // failed-validate tail after the whole plan ran, so pin the actual STOP —
    // deleting the early `gated()` return must fail here.
    const pipeline: PipelineV1 = {
      version: 1,
      pipeline: 'branching-gate',
      nodes: [
        { id: 'a', type: 'source', source: { kind: 'file' } },
        { id: 'gateA', type: 'validate', input: 'a', contract: 'contracts/gate.yaml' },
        { id: 'b', type: 'source', source: { kind: 'file' } },
        { id: 'outB', type: 'sql', inputs: ['b'], sql: 'SELECT 1 AS value' },
      ],
    }
    const ops = new FakeOps()
    ops.validationValid = false
    const result = await executePipeline(
      pipeline,
      {
        sources: [
          { nodeId: 'a', source: SOURCE_FILE },
          { nodeId: 'b', source: SOURCE_FILE },
        ],
        contracts: [{ nodeId: 'gateA', contract: {} }],
        compilers: PASS_THROUGH_COMPILERS,
      },
      ops,
    )
    expect(result.status).toBe('gated')
    if (result.status !== 'gated') return
    expect(result.nodes.at(-1)?.nodeId).toBe('gateA')
    expect(ops.calls.some((call) => call.startsWith('materialize:outB'))).toBe(false)
  })

  it('refuses a caller-supplied plan with a non-local mode or an inconsistent statement', async () => {
    const base = {
      nodeId: 'out',
      kind: 'sql' as const,
      relation: 'out',
      quotedRelation: '"out"',
      sql: 'SELECT 1 AS value',
    }
    const unsupported = await expectRefusalOf(
      {
        order: ['out'],
        nodes: [{ ...base, materialization: 'publish', statement: 'x', statementKind: 'view' }],
      },
      {},
    )
    expect(unsupported.reason).toBe('unsupported-materialization')
    const missingStatement = await expectRefusalOf(
      { order: ['out'], nodes: [{ ...base, materialization: 'view' }] },
      {},
    )
    expect(missingStatement.reason).toBe('invalid-plan')
    const wrongKind = await expectRefusalOf(
      {
        order: ['out'],
        nodes: [
          {
            ...base,
            materialization: 'table',
            statement: 'CREATE TABLE "out" AS SELECT 1',
            statementKind: 'view',
          },
        ],
      },
      {},
    )
    expect(wrongKind.reason).toBe('invalid-plan')
  })

  it('refuses a plan whose statement is missing even when statementKind is consistent', async () => {
    // Claim 7: the existing `missingStatement` fixture also omits
    // `statementKind`, so the consistent-kind check refuses it even with the
    // presence check gone (unobserved). Keeping `statementKind: 'view'` and
    // omitting only `statement` isolates the presence check: deleting it lets
    // the plan fall through and execute.
    const absentStatement = await expectRefusalOf(
      {
        order: ['out'],
        nodes: [
          {
            nodeId: 'out',
            kind: 'sql',
            relation: 'out',
            quotedRelation: '"out"',
            sql: 'SELECT 1 AS value',
            materialization: 'view',
            statementKind: 'view',
          },
        ],
      },
      {},
    )
    expect(absentStatement.reason).toBe('invalid-plan')
  })

  it('refuses structurally malformed caller-supplied plans', async () => {
    const base = {
      nodeId: 'out',
      kind: 'sql' as const,
      relation: 'out',
      quotedRelation: '"out"',
      sql: 'SELECT 1',
      materialization: 'view' as const,
      statement: 'CREATE OR REPLACE VIEW "out" AS SELECT 1',
      statementKind: 'view' as const,
    }
    const mismatched = await expectRefusalOf(
      { order: ['out', 'x'], nodes: [base] } as unknown as PipelineCompilePlan,
      {},
    )
    expect(mismatched.reason).toBe('invalid-plan')
    const duplicate = await expectRefusalOf(
      { order: ['out', 'out'], nodes: [base, base] } as unknown as PipelineCompilePlan,
      {},
    )
    expect(duplicate.reason).toBe('invalid-plan')
    const sourceWithSql = await expectRefusalOf(
      {
        order: ['src'],
        nodes: [
          {
            nodeId: 'src',
            kind: 'source',
            relation: 'src',
            quotedRelation: '"src"',
            sql: 'SELECT 1',
          },
        ],
      } as unknown as PipelineCompilePlan,
      {},
    )
    expect(sourceWithSql.reason).toBe('invalid-plan')
    const unknownKind = await expectRefusalOf(
      { order: ['out'], nodes: [{ ...base, kind: 'validate' }] } as unknown as PipelineCompilePlan,
      {},
    )
    expect(unknownKind.reason).toBe('invalid-plan')
  })
})

/** Refuse-with-no-engine-call helper shared by the gate tests. */
async function expectRefusalOf(
  input: Parameters<typeof executePipeline>[0],
  options: Parameters<typeof executePipeline>[1],
): Promise<PipelineRunRefusalError> {
  const ops = new FakeOps()
  let error: unknown
  try {
    await executePipeline(input, options, ops)
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(PipelineRunRefusalError)
  expect(ops.calls).toEqual([])
  return error as PipelineRunRefusalError
}

/** Run-error helper: execute and require a typed `PipelineRunError`. */
async function runErrorOf(
  input: Parameters<typeof executePipeline>[0],
  options: Parameters<typeof executePipeline>[1],
): Promise<PipelineRunError> {
  let error: unknown
  try {
    await executePipeline(input, options, new FakeOps())
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(PipelineRunError)
  return error as PipelineRunError
}

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
