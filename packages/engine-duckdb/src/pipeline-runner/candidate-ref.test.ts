// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Candidate-reference derivation tests (p3-2): the Q4 quartet mapping off a
 * completed/gated run, the typed refusal discipline, the publish-boundary
 * pin (failing-before-fix), and the value-free checks — all pure, against
 * fake introspection, mirroring the runner test discipline.
 */
import { describe, expect, it } from 'vitest'
import { buildDcrArtifact } from '@assay/pipeline'
import type { PipelineV1 } from '@assay/pipeline'
import { PipelineRunRefusalError } from './errors.js'
import {
  candidateVersionRefFromRun,
  CANDIDATE_SCHEMA_FINGERPRINT_ALGORITHM,
} from './candidate-ref.js'
import { executePipeline, pipelineExportPath } from './runner.js'
import type { PipelineRunEngineOps, PipelineRunSourceFile } from './runner.js'
import type { EngineValidationPlan, EngineValidationResult } from '../validate-plan-wire.js'

const SOURCE_FILE: PipelineRunSourceFile = {
  name: 'customers.parquet',
  getFile: async () => new File([new Uint8Array([1])], 'customers.parquet'),
}

function sourceOptions(nodeIds: readonly string[] = ['customers']): readonly {
  nodeId: string
  source: PipelineRunSourceFile
}[] {
  return nodeIds.map((nodeId) => ({ nodeId, source: SOURCE_FILE }))
}

/** source → transform(SG filter) → sql out (view). */
function outPipeline(): PipelineV1 {
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

/** source → transform(SG filter, table) — a single producing node. */
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

/** source → sql out (export). */
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

/** source → transform(SG) → sql with publish-mode materialization — the boundary. */
function publishModePipeline(): PipelineV1 {
  return {
    version: 1,
    pipeline: 'publish-mode',
    nodes: [
      { id: 'customers', type: 'source', source: { kind: 'file' } },
      {
        id: 'out',
        type: 'sql',
        materialization: 'publish',
        inputs: ['customers'],
        sql: 'SELECT customer_id FROM customers',
      },
    ],
  }
}

/** Two sources joined — parents derive from both plan inputs. */
function joinPipeline(): PipelineV1 {
  return {
    version: 1,
    pipeline: 'join',
    nodes: [
      { id: 'a', type: 'source', source: { kind: 'file' } },
      { id: 'b', type: 'source', source: { kind: 'file' } },
      {
        id: 'out',
        type: 'sql',
        inputs: ['b', 'a'],
        sql: 'SELECT a.customer_id FROM a JOIN b USING (customer_id)',
      },
    ],
  }
}

/** source → sg → gate(validate sg, fails) → out: a terminal gate leaves `out` unexecuted. */
function lateNodeGatePipeline(): PipelineV1 {
  return {
    version: 1,
    pipeline: 'late-gate',
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
      { id: 'out', type: 'sql', inputs: ['sg'], sql: 'SELECT customer_id FROM sg' },
    ],
  }
}

/** A minimal but realistic engine-op fake (no engine involved). */
class FakeOps implements PipelineRunEngineOps {
  schema: readonly { readonly name: string; readonly type: string }[] = [
    { name: 'customer_id', type: 'BIGINT' },
  ]
  validationValid = true
  schemaError: Error | null = null

  async registerSource(): Promise<number> {
    return 5
  }

  async materialize(): Promise<number> {
    return 2
  }

  async exportRelation(
    _relation: string,
    _sql: string,
    path: string,
  ): Promise<{ path: string; rowCount: number; bytes: number }> {
    return { path, rowCount: 5, bytes: 3 }
  }

  async schemaOf(
    relation: string,
  ): Promise<readonly { readonly name: string; readonly type: string }[]> {
    // The fake introspects every relation identically; referenced so the
    // parameter is used.
    void relation
    if (this.schemaError !== null) throw this.schemaError
    return this.schema
  }

  async validate(): Promise<EngineValidationResult> {
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
}

const GATE_COMPILERS = {
  validate: () => ({ ok: true, plan: {} as EngineValidationPlan }),
}

async function completedOf(
  pipeline: PipelineV1,
  ops: FakeOps = new FakeOps(),
  sourceIds: readonly string[] = ['customers'],
) {
  const result = await executePipeline(pipeline, { sources: sourceOptions(sourceIds) }, ops)
  if (result.status !== 'completed')
    throw new Error(`expected a completed run, got ${result.status}`)
  return result
}

const GATE_CONTRACTS = [{ nodeId: 'gate', contract: { synthetic: true } }]

async function gatedOf(pipeline: PipelineV1, ops: FakeOps = new FakeOps()) {
  const result = await executePipeline(
    pipeline,
    { sources: sourceOptions(), compilers: GATE_COMPILERS, contracts: GATE_CONTRACTS },
    ops,
  )
  if (result.status !== 'gated') throw new Error(`expected a gated run, got ${result.status}`)
  return result
}

/** Independent SHA-256 of the canonical rendering (does not trust the implementation). */
async function independentFingerprint(
  columns: readonly { name: string; type: string }[],
): Promise<string> {
  const rendering = [...columns]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((column) => `${column.name}:${column.type}`)
    .join(',')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rendering))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function refusalOf(promise: Promise<unknown>): Promise<PipelineRunRefusalError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof PipelineRunRefusalError) return error
    throw error
  }
  throw new Error('expected the derivation to refuse')
}

describe('candidateVersionRefFromRun — completed runs (happy path)', () => {
  it('derives the Q4 quartet from a completed run’s materialized output', async () => {
    const ops = new FakeOps()
    const run = await completedOf(outPipeline(), ops)
    const ref = await candidateVersionRefFromRun({
      run,
      plan: outPipeline(),
      nodeId: 'out',
      datasetId: 'customers-clean',
      schemaOf: (relation) => ops.schemaOf(relation),
    })
    const fingerprint = await independentFingerprint(ops.schema)
    expect(ref).toEqual({
      datasetId: 'customers-clean',
      versionId: `customers-clean@${fingerprint.slice(0, 16)}`,
      schemaFingerprint: { algorithm: CANDIDATE_SCHEMA_FINGERPRINT_ALGORITHM, value: fingerprint },
      provenance: { transformationRecipe: 'test|out', parentVersionIds: ['sg'] },
      materialization: { node: 'out' },
    })
  })

  it('is deterministic: re-deriving from the same run yields an identical ref (no wall-clock)', async () => {
    const ops = new FakeOps()
    const run = await completedOf(outPipeline(), ops)
    const derive = () =>
      candidateVersionRefFromRun({
        run,
        plan: outPipeline(),
        nodeId: 'out',
        datasetId: 'customers-clean',
        schemaOf: (relation) => ops.schemaOf(relation),
      })
    expect(await derive()).toEqual(await derive())
  })

  it('the fingerprint is order-insensitive over the introspected columns', async () => {
    const forward = new FakeOps()
    forward.schema = [
      { name: 'a', type: 'BIGINT' },
      { name: 'b', type: 'VARCHAR' },
    ]
    const backward = new FakeOps()
    backward.schema = [
      { name: 'b', type: 'VARCHAR' },
      { name: 'a', type: 'BIGINT' },
    ]
    const refA = await candidateVersionRefFromRun({
      run: await completedOf(tablePipeline(), forward),
      plan: tablePipeline(),
      nodeId: 'sg',
      datasetId: 'd',
      schemaOf: (relation) => forward.schemaOf(relation),
    })
    const refB = await candidateVersionRefFromRun({
      run: await completedOf(tablePipeline(), backward),
      plan: tablePipeline(),
      nodeId: 'sg',
      datasetId: 'd',
      schemaOf: (relation) => backward.schemaOf(relation),
    })
    expect(refB.schemaFingerprint).toEqual(refA.schemaFingerprint)
  })

  it('an explicit version id, recipe, and parents override the derived defaults', async () => {
    const ops = new FakeOps()
    const run = await completedOf(outPipeline(), ops)
    const ref = await candidateVersionRefFromRun({
      run,
      plan: outPipeline(),
      nodeId: 'out',
      datasetId: 'customers-clean',
      versionId: 'v42',
      transformationRecipe: 'recipes/clean.sql',
      parentVersionIds: ['v1', 'v1', 'v0'],
      schemaOf: (relation) => ops.schemaOf(relation),
    })
    expect(ref.versionId).toBe('v42')
    expect(ref.provenance?.transformationRecipe).toBe('recipes/clean.sql')
    expect(ref.provenance?.parentVersionIds).toEqual(['v0', 'v1'])
  })

  it('parents derive from the plan inputs, canonicalized (sorted, deduplicated)', async () => {
    const ops = new FakeOps()
    const run = await completedOf(joinPipeline(), ops, ['a', 'b'])
    const ref = await candidateVersionRefFromRun({
      run,
      plan: joinPipeline(),
      nodeId: 'out',
      datasetId: 'joined',
      schemaOf: (relation) => ops.schemaOf(relation),
    })
    expect(ref.provenance?.parentVersionIds).toEqual(['a', 'b'])
    expect(ref.provenance?.transformationRecipe).toBe('join|out')
  })

  it('the derived reference builds through the pure DCR builder (builder-clean)', async () => {
    const ops = new FakeOps()
    const run = await completedOf(exportPipeline(), ops)
    const candidate = await candidateVersionRefFromRun({
      run,
      plan: exportPipeline(),
      nodeId: 'out',
      datasetId: 'customers-clean',
      schemaOf: (relation) => ops.schemaOf(relation),
    })
    const base = {
      datasetId: 'customers-clean',
      versionId: 'v1',
      schemaFingerprint: {
        algorithm: CANDIDATE_SCHEMA_FINGERPRINT_ALGORITHM,
        value: 'a'.repeat(64),
      },
      materialization: { node: 'base' },
    }
    const built = buildDcrArtifact({ base, candidate, deltas: {} })
    expect(built.ok).toBe(true)
  })
})

describe('candidateVersionRefFromRun — gated runs', () => {
  it('derives the candidate from a gated run’s executed producing node', async () => {
    const ops = new FakeOps()
    ops.validationValid = false
    const run = await gatedOf(lateNodeGatePipeline(), ops)
    expect(run.gatedAt).toBe('gate')
    const ref = await candidateVersionRefFromRun({
      run,
      plan: lateNodeGatePipeline(),
      nodeId: 'sg',
      datasetId: 'customers-clean',
      schemaOf: (relation) => ops.schemaOf(relation),
    })
    expect(ref.materialization).toEqual({ node: 'sg' })
    expect(ref.datasetId).toBe('customers-clean')
  })

  it('refuses a gated run whose candidate node never executed', async () => {
    const ops = new FakeOps()
    ops.validationValid = false
    const run = await gatedOf(lateNodeGatePipeline(), ops)
    const refusal = await refusalOf(
      candidateVersionRefFromRun({
        run,
        plan: lateNodeGatePipeline(),
        nodeId: 'out',
        datasetId: 'customers-clean',
        schemaOf: (relation) => ops.schemaOf(relation),
      }),
    )
    expect(refusal.reason).toBe('candidate-node-absent')
    expect(refusal.nodeId).toBe('out')
    expect(refusal.message).toBe(
      'the candidate node did not execute in this run, so it left no materialized output',
    )
  })
})

describe('candidateVersionRefFromRun — the export form (value-free paths)', () => {
  it('an export node carries the runner’s value-free OPFS artifact path', async () => {
    const ops = new FakeOps()
    const run = await completedOf(exportPipeline(), ops)
    const ref = await candidateVersionRefFromRun({
      run,
      plan: exportPipeline(),
      nodeId: 'out',
      datasetId: 'customers-clean',
      schemaOf: (relation) => ops.schemaOf(relation),
    })
    expect(ref.materialization).toEqual({ export: pipelineExportPath('out') })
    expect(ref.materialization).toEqual({
      export: 'assay-exports/assay-pipeline-export-out.parquet',
    })
  })

  it('the export stem stays encoded (value-free) for non-safe node ids', async () => {
    const pipeline: PipelineV1 = {
      ...exportPipeline(),
      nodes: exportPipeline().nodes.map((node) =>
        node.type === 'sql' && node.id === 'out' ? { ...node, id: 'out ré sumé' } : node,
      ),
    }
    const ops = new FakeOps()
    const run = await completedOf(pipeline, ops)
    const ref = await candidateVersionRefFromRun({
      run,
      plan: pipeline,
      nodeId: 'out ré sumé',
      datasetId: 'customers-clean',
      schemaOf: (relation) => ops.schemaOf(relation),
    })
    if (!('export' in ref.materialization)) throw new Error('expected the export form')
    expect(ref.materialization.export).toBe(pipelineExportPath('out ré sumé'))
    expect(ref.materialization.export).toMatch(
      /^assay-exports\/assay-pipeline-export-[A-Za-z0-9_~-]+\.parquet$/,
    )
    expect(ref.materialization.export).not.toMatch(/[^\x20-\x7e]/)
  })

  it('an export result without its artifact path refuses (candidate-not-materialized)', async () => {
    const ops = new FakeOps()
    const run = await completedOf(exportPipeline(), ops)
    const stripped = {
      ...run,
      nodes: run.nodes.map((node) =>
        node.nodeId === 'out' ? { ...node, exportPath: undefined } : node,
      ),
    }
    const refusal = await refusalOf(
      candidateVersionRefFromRun({
        run: stripped,
        plan: exportPipeline(),
        nodeId: 'out',
        datasetId: 'd',
        schemaOf: (relation) => ops.schemaOf(relation),
      }),
    )
    expect(refusal.reason).toBe('candidate-not-materialized')
  })
})

describe('candidateVersionRefFromRun — refusals (typed, located, value-free)', () => {
  it('refuses a node that is not a data node of the plan (candidate-node-unknown)', async () => {
    const ops = new FakeOps()
    const run = await completedOf(outPipeline(), ops)
    for (const nodeId of ['nope', 'gate-not-in-plan']) {
      const refusal = await refusalOf(
        candidateVersionRefFromRun({
          run,
          plan: outPipeline(),
          nodeId,
          datasetId: 'd',
          schemaOf: (relation) => ops.schemaOf(relation),
        }),
      )
      expect(refusal.reason).toBe('candidate-node-unknown')
      expect(refusal.nodeId).toBe(nodeId)
    }
  })

  it('refuses a gate node address (a validate node is not a data node)', async () => {
    const ops = new FakeOps()
    ops.validationValid = false
    const run = await gatedOf(lateNodeGatePipeline(), ops)
    const refusal = await refusalOf(
      candidateVersionRefFromRun({
        run,
        plan: lateNodeGatePipeline(),
        nodeId: 'gate',
        datasetId: 'd',
        schemaOf: (relation) => ops.schemaOf(relation),
      }),
    )
    expect(refusal.reason).toBe('candidate-node-unknown')
  })

  it('refuses a canceled run even when the node executed (candidate-run-canceled)', async () => {
    const { PipelineRunGuard } = await import('./guard.js')
    const ops = new FakeOps()
    const guard = new PipelineRunGuard()
    const run = await executePipeline(
      outPipeline(),
      {
        sources: sourceOptions(),
        guard,
        onNode: () => guard.invalidate(),
      },
      ops,
    )
    if (run.status !== 'canceled') throw new Error('expected a canceled run')
    const refusal = await refusalOf(
      candidateVersionRefFromRun({
        run,
        plan: outPipeline(),
        nodeId: 'customers',
        datasetId: 'd',
        schemaOf: (relation) => ops.schemaOf(relation),
      }),
    )
    expect(refusal.reason).toBe('candidate-run-canceled')
  })

  it('refuses a gate-materialized result as the candidate (candidate-not-materialized)', async () => {
    const ops = new FakeOps()
    const run = await completedOf(outPipeline(), ops)
    const gateResult = {
      ...run,
      nodes: run.nodes.map((node) =>
        node.nodeId === 'out'
          ? { ...node, materialization: 'gate' as const, gate: undefined }
          : node,
      ),
    }
    const refusal = await refusalOf(
      candidateVersionRefFromRun({
        run: gateResult,
        plan: outPipeline(),
        nodeId: 'out',
        datasetId: 'd',
        schemaOf: (relation) => ops.schemaOf(relation),
      }),
    )
    expect(refusal.reason).toBe('candidate-not-materialized')
  })

  it('refuses a source result as the candidate (candidate-not-materialized)', async () => {
    const ops = new FakeOps()
    const run = await completedOf(outPipeline(), ops)
    const refusal = await refusalOf(
      candidateVersionRefFromRun({
        run,
        plan: outPipeline(),
        nodeId: 'customers',
        datasetId: 'd',
        schemaOf: (relation) => ops.schemaOf(relation),
      }),
    )
    expect(refusal.reason).toBe('candidate-not-materialized')
    expect(refusal.message).toBe('the candidate node produced no materialized output to reference')
  })

  it('refuses when no introspection op was supplied (candidate-schema-unavailable)', async () => {
    const ops = new FakeOps()
    const run = await completedOf(outPipeline(), ops)
    const refusal = await refusalOf(
      candidateVersionRefFromRun({
        run,
        plan: outPipeline(),
        nodeId: 'out',
        datasetId: 'd',
      }),
    )
    expect(refusal.reason).toBe('candidate-schema-unavailable')
  })

  it('refuses when the relation is gone (dropped view) — the raw error never crosses the seam', async () => {
    const ops = new FakeOps()
    ops.schemaError = new Error('Catalog Error: relation "secret/internal-table" does not exist')
    const run = await completedOf(outPipeline(), ops)
    const refusal = await refusalOf(
      candidateVersionRefFromRun({
        run,
        plan: outPipeline(),
        nodeId: 'out',
        datasetId: 'd',
        schemaOf: (relation) => ops.schemaOf(relation),
      }),
    )
    expect(refusal.reason).toBe('candidate-schema-unavailable')
    expect(refusal.message).not.toContain('secret')
    expect(refusal.message).not.toContain('Catalog Error')
  })

  it('refuses an empty introspected schema (candidate-schema-unavailable)', async () => {
    const ops = new FakeOps()
    ops.schema = []
    const run = await completedOf(outPipeline(), ops)
    const refusal = await refusalOf(
      candidateVersionRefFromRun({
        run,
        plan: outPipeline(),
        nodeId: 'out',
        datasetId: 'd',
        schemaOf: (relation) => ops.schemaOf(relation),
      }),
    )
    expect(refusal.reason).toBe('candidate-schema-unavailable')
  })

  it('refuses unusable identity strings (candidate-identity-invalid)', async () => {
    const ops = new FakeOps()
    const run = await completedOf(outPipeline(), ops)
    const derive = (over: {
      datasetId?: string
      versionId?: string
      transformationRecipe?: string
      parentVersionIds?: readonly string[]
    }) =>
      candidateVersionRefFromRun({
        run,
        plan: outPipeline(),
        nodeId: 'out',
        datasetId: 'd',
        schemaOf: (relation) => ops.schemaOf(relation),
        ...over,
      })
    for (const datasetId of ['', 'bad\u0000id']) {
      const refusal = await refusalOf(derive({ datasetId }))
      expect(refusal.reason).toBe('candidate-identity-invalid')
    }
    for (const versionId of ['', 'bad\u0000id']) {
      const refusal = await refusalOf(derive({ versionId }))
      expect(refusal.reason).toBe('candidate-identity-invalid')
    }
    for (const transformationRecipe of ['', 'bad\u0000recipe']) {
      const refusal = await refusalOf(derive({ transformationRecipe }))
      expect(refusal.reason).toBe('candidate-identity-invalid')
    }
    const refusal = await refusalOf(derive({ parentVersionIds: ['ok', ''] }))
    expect(refusal.reason).toBe('candidate-identity-invalid')
  })

  it('refuses a caller-supplied plan with a non-local mode (unsupported-materialization)', async () => {
    const ops = new FakeOps()
    const run = await completedOf(outPipeline(), ops)
    const cachePlan = {
      order: ['out'],
      nodes: [
        {
          nodeId: 'out',
          kind: 'sql' as const,
          relation: 'out',
          quotedRelation: '"out"',
          sql: 'SELECT 1',
          materialization: 'cache' as const,
        },
      ],
    }
    const refusal = await refusalOf(
      candidateVersionRefFromRun({
        run,
        plan: cachePlan,
        nodeId: 'out',
        datasetId: 'd',
        schemaOf: (relation) => ops.schemaOf(relation),
      }),
    )
    expect(refusal.reason).toBe('unsupported-materialization')
  })
})

describe('candidateVersionRefFromRun — the publish boundary (p3-2 pin)', () => {
  // The synthetic run stands in for a hypothetical future runner that
  // executed publish mode: the derivation must still refuse, because the
  // publish boundary is explicit (ADR 0033/0035). Wiring publish would have
  // to delete this pin (P3 queue §2 STOP boundary).
  async function publishModeWorld() {
    const ops = new FakeOps()
    const run = await completedOf(outPipeline(), ops)
    return { run, ops }
  }

  it('a publish-mode producing node refuses (publish-materialization) — never derives', async () => {
    const { run, ops } = await publishModeWorld()
    const refusal = await refusalOf(
      candidateVersionRefFromRun({
        run,
        plan: publishModePipeline(),
        nodeId: 'out',
        datasetId: 'd',
        schemaOf: (relation) => ops.schemaOf(relation),
      }),
    )
    expect(refusal.name).toBe('PipelineRunRefusalError')
    expect(refusal.reason).toBe('publish-materialization')
    expect(refusal.nodeId).toBe('out')
    expect(refusal.message).toContain('ADR 0033/0035')
  })

  it('the publish refusal fires before any introspection (no engine seam is touched)', async () => {
    const { run } = await publishModeWorld()
    let introspected = 0
    const refusal = await refusalOf(
      candidateVersionRefFromRun({
        run,
        plan: publishModePipeline(),
        nodeId: 'out',
        datasetId: 'd',
        schemaOf: () => {
          introspected += 1
          return Promise.resolve([{ name: 'x', type: 'BIGINT' }])
        },
      }),
    )
    expect(refusal.reason).toBe('publish-materialization')
    expect(introspected).toBe(0)
  })
})

describe('candidateVersionRefFromRun — value-free discipline (ADR 0025)', () => {
  it('no column identity enters the reference — only the hash of it', async () => {
    const ops = new FakeOps()
    ops.schema = [
      { name: 'salary_cc', type: 'DECIMAL(18,2)' },
      { name: 'customer_id', type: 'BIGINT' },
    ]
    const run = await completedOf(tablePipeline(), ops)
    const ref = await candidateVersionRefFromRun({
      run,
      plan: tablePipeline(),
      nodeId: 'sg',
      datasetId: 'd',
      schemaOf: (relation) => ops.schemaOf(relation),
    })
    const rendered = JSON.stringify(ref)
    expect(rendered).not.toContain('salary_cc')
    expect(rendered).not.toContain('DECIMAL')
    expect(ref.schemaFingerprint.value).toMatch(/^[0-9a-f]{64}$/)
  })

  it('the exported path never carries raw user text for hostile node ids', async () => {
    const hostile = 'out \u0007 ["<script>]'
    const pipeline: PipelineV1 = {
      ...exportPipeline(),
      nodes: exportPipeline().nodes.map((node) =>
        node.type === 'sql' && node.id === 'out' ? { ...node, id: hostile } : node,
      ),
    }
    const ops = new FakeOps()
    const run = await completedOf(pipeline, ops)
    const ref = await candidateVersionRefFromRun({
      run,
      plan: pipeline,
      nodeId: hostile,
      datasetId: 'd',
      schemaOf: (relation) => ops.schemaOf(relation),
    })
    if (!('export' in ref.materialization)) throw new Error('expected the export form')
    expect(ref.materialization.export).toBe(pipelineExportPath(hostile))
    expect(ref.materialization.export).toMatch(
      /^assay-exports\/assay-pipeline-export-[A-Za-z0-9_~-]+\.parquet$/,
    )
  })

  it('every refusal message is a fixed value-free class (no node-id-bearing prose)', async () => {
    const ops = new FakeOps()
    const run = await completedOf(outPipeline(), ops)
    const refusals = await Promise.all([
      refusalOf(
        candidateVersionRefFromRun({
          run,
          plan: outPipeline(),
          nodeId: 'customers',
          datasetId: 'd',
          schemaOf: (relation) => ops.schemaOf(relation),
        }),
      ),
      refusalOf(
        candidateVersionRefFromRun({
          run,
          plan: outPipeline(),
          nodeId: 'nope',
          datasetId: 'd',
          schemaOf: (relation) => ops.schemaOf(relation),
        }),
      ),
      refusalOf(
        candidateVersionRefFromRun({
          run,
          plan: outPipeline(),
          nodeId: 'out',
          datasetId: '',
          schemaOf: (relation) => ops.schemaOf(relation),
        }),
      ),
      refusalOf(
        candidateVersionRefFromRun({
          run: { ...run, status: 'canceled', nextNodeId: null },
          plan: outPipeline(),
          nodeId: 'out',
          datasetId: 'SENTINEL-identity-xyz',
          schemaOf: (relation) => ops.schemaOf(relation),
        }),
      ),
    ])
    for (const refusal of refusals) {
      expect(refusal.message).toBeTypeOf('string')
      // Messages name the class of the problem, never the caller's strings.
      expect(refusal.message).not.toContain('SENTINEL-identity-xyz')
    }
  })
})
