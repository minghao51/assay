// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for `assay dcr` (p3-3): option resolution, the exclusive-write
 * (ADR 0012) pin, the derivation core over FAKE runs (typed refusals, the
 * D19-OQ-5 dangling-materialization pin, the honest no-verdict roll-up),
 * and the export-report renderers' byte contracts. The end-to-end journeys
 * (including the golden byte pin) live in `dcr.integration.test.ts`.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseDcr, serializeDcr } from '@assay/pipeline'
import type { PipelineV1 } from '@assay/pipeline'
import type { PipelineRunNodeResult, PipelineRunResult } from '@assay/engine-duckdb/node'
import { deriveDcrArtifact, resolveDcrOptions, runDcrCommand, writeDcrArtifactNew } from './dcr.js'
import type { DcrOptions } from './dcr.js'
import type { CommandContext } from './context.js'
import { renderHumanDcrExportReport, renderJsonDcrExportReport } from './report-dcr.js'
import { REPORT_VERSION } from './report-shared.js'
import { plainStyle } from './style.js'

// A minimal well-typed IR: src → left (the base side) → right (the candidate side).
const PLAN: PipelineV1 = {
  version: 1,
  pipeline: 'unit_plan',
  nodes: [
    { id: 'src', type: 'source', source: { kind: 'file', path: 'secret-dataset.csv' } },
    {
      id: 'left',
      type: 'transform',
      inputs: ['src'],
      operation: { operation: 'rename', args: { columns: { a: 'b' } } },
    },
    {
      id: 'right',
      type: 'transform',
      inputs: ['left'],
      operation: { operation: 'filter', args: { predicates: [] } },
    },
  ],
}

function dataNode(
  nodeId: string,
  relation: string,
  rowCount: number,
  materialization: PipelineRunNodeResult['materialization'],
  gate?: PipelineRunNodeResult['gate'],
): PipelineRunNodeResult {
  return { nodeId, relation, rowCount, materialization, ...(gate === undefined ? {} : { gate }) }
}

/** A completed three-node run: src → left → right (no gates executed). */
const COMPLETED_RUN: PipelineRunResult = {
  status: 'completed',
  nodes: [
    dataNode('src', 'src', 5, 'source'),
    dataNode('left', 'left', 5, 'view'),
    dataNode('right', 'right', 2, 'view'),
  ],
}

/** The two materialized relations' schemas: a column leaves and one arrives. */
function unitSchemaOf(relation: string): readonly { name: string; type: string }[] {
  if (relation === 'left') {
    return [
      { name: 'country', type: 'VARCHAR' },
      { name: 'customer_ref', type: 'BIGINT' },
    ]
  }
  if (relation === 'right') {
    return [
      { name: 'country', type: 'VARCHAR' },
      { name: 'customers', type: 'BIGINT' },
    ]
  }
  return [
    { name: 'customer_id', type: 'BIGINT' },
    { name: 'country', type: 'VARCHAR' },
  ]
}

function deriveInput(overrides?: {
  readonly plan?: PipelineV1
  readonly run?: PipelineRunResult
  readonly schemaOf?: (relation: string) => Promise<readonly { name: string; type: string }[]>
  readonly baseNodeId?: string
  readonly candidateNodeId?: string
  readonly baseDatasetId?: string
}) {
  return {
    plan: overrides?.plan ?? PLAN,
    run: overrides?.run ?? COMPLETED_RUN,
    schemaOf: overrides?.schemaOf ?? (async (relation: string) => unitSchemaOf(relation)),
    baseNodeId: overrides?.baseNodeId ?? 'left',
    baseDatasetId: overrides?.baseDatasetId ?? 'unit_base',
    candidateNodeId: overrides?.candidateNodeId ?? 'right',
    candidateDatasetId: 'unit_candidate',
  }
}

describe('resolveDcrOptions', () => {
  const base = {
    positionals: ['pipeline.yaml'],
    out: 'artifact.yaml',
    baseNode: 'left',
    baseDatasetId: 'b',
    candidateNode: 'right',
    candidateDatasetId: 'c',
  }

  it('resolves the full flag set', () => {
    const options = resolveDcrOptions({ ...base, format: 'json', keys: ['k'] })
    expect(options).toMatchObject({
      pipelinePath: 'pipeline.yaml',
      outPath: 'artifact.yaml',
      baseNodeId: 'left',
      candidateNodeId: 'right',
      format: 'json',
      keys: ['k'],
    })
  })

  it('defaults the format to human and keys to empty', () => {
    const options = resolveDcrOptions({ ...base })
    expect(options.format).toBe('human')
    expect(options.keys).toEqual([])
  })

  it.each([
    ['missing the pipeline path', { positionals: [] }, 'dcr requires a pipeline file path'],
    ['missing --out', { ...base, out: undefined }, 'dcr requires --out <path>'],
    ['missing --base-node', { ...base, baseNode: undefined }, 'dcr requires --base-node'],
    [
      'missing --base-dataset-id',
      { ...base, baseDatasetId: undefined },
      'dcr requires --base-dataset-id',
    ],
    [
      'missing --candidate-node',
      { ...base, candidateNode: undefined },
      'dcr requires --candidate-node',
    ],
    [
      'missing --candidate-dataset-id',
      { ...base, candidateDatasetId: undefined },
      'dcr requires --candidate-dataset-id',
    ],
  ] as const)('%s (exit 2)', (_name, flags, message) => {
    expect(() => resolveDcrOptions(flags)).toThrow(message)
  })

  it('refuses the same node for both sides', () => {
    expect(() => resolveDcrOptions({ ...base, candidateNode: 'left' })).toThrow(
      'must be different nodes',
    )
  })

  it('rejects cross-command flags, never silently ignores them', () => {
    expect(() => resolveDcrOptions({ ...base, contract: 'c.yaml' })).toThrow(
      'dcr does not take --contract',
    )
    expect(() => resolveDcrOptions({ ...base, infer: true })).toThrow('dcr does not take --infer')
    expect(() => resolveDcrOptions({ ...base, sampleLimit: '5' })).toThrow(
      'dcr does not take --sample-limit',
    )
  })

  it('refuses an unknown --format spelling', () => {
    expect(() => resolveDcrOptions({ ...base, format: 'yaml' })).toThrow(
      "--format must be 'human' or 'json'",
    )
  })
})

describe('writeDcrArtifactNew — the ADR 0012 no-rewrite pin', () => {
  it('creates a new file with the exact bytes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'assay-dcr-unit-'))
    const out = join(dir, 'artifact.yaml')
    const text = 'format: assay-dcr\n'
    const written = await writeDcrArtifactNew(out, text)
    expect(written).toEqual({ ok: true, bytes: Buffer.byteLength(text, 'utf8') })
    expect(readFileSync(out, 'utf8')).toBe('format: assay-dcr\n')
  })

  it('refuses an existing path and leaves its bytes untouched', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'assay-dcr-unit-'))
    const out = join(dir, 'artifact.yaml')
    writeFileSync(out, 'original bytes\n')
    const refused = await writeDcrArtifactNew(out, 'replacement bytes\n')
    expect(refused).toEqual({ ok: false, reason: 'path-exists' })
    expect(readFileSync(out, 'utf8')).toBe('original bytes\n')
  })
})

describe('deriveDcrArtifact — the one construction path over the p3-2 refs', () => {
  it('derives both sides, drift, and the round-trippable artifact', async () => {
    const derived = await deriveDcrArtifact(deriveInput())
    expect(derived.ok).toBe(true)
    if (!derived.ok) return
    const { artifact, base, candidate } = derived
    expect(artifact.format).toBe('assay-dcr')
    expect(base.datasetId).toBe('unit_base')
    expect(base.materialization).toEqual({ node: 'left' })
    expect(candidate.materialization).toEqual({ node: 'right' })
    // Deterministic default version ids: <datasetId>@<fingerprint prefix>.
    expect(base.versionId).toMatch(/^unit_base@[0-9a-f]{16}/)
    expect(candidate.versionId).toMatch(/^unit_candidate@[0-9a-f]{16}/)
    // The structural drift the fake schemas encode: customer_ref leaves, customers arrives.
    expect(derived.schemaDriftFindings).toBe(2)
    // The artifact parses and canonicalizes to identical bytes (the builder's own discipline).
    const text = serializeDcr(artifact)
    const parsed = parseDcr(text)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(serializeDcr(parsed.artifact)).toBe(text)
  })

  it('carries the executed validate verdicts and their honest roll-up', async () => {
    const gatedRun: PipelineRunResult = {
      status: 'gated',
      gatedAt: 'quality',
      gate: 'validation-failed',
      nextNodeId: null,
      nodes: [
        dataNode('src', 'src', 5, 'source'),
        dataNode('left', 'left', 5, 'view'),
        dataNode('right', 'right', 2, 'view'),
        dataNode('quality', 'right', 2, 'gate', {
          class: 'validate',
          input: 'right',
          valid: false,
          violatedRules: 1,
        }),
      ],
    }
    const derived = await deriveDcrArtifact(deriveInput({ run: gatedRun }))
    expect(derived.ok).toBe(true)
    if (!derived.ok) return
    expect(derived.validationVerdicts).toBe(1)
    expect(derived.validationValid).toBe(false)
    expect(derived.artifact.validation).toEqual([
      { nodeId: 'quality', input: 'right', valid: false, violatedRules: 1, rowCount: 2 },
    ])
  })

  it('rolls up mixed verdicts to false and all-pass to true', async () => {
    const gate = (valid: boolean): PipelineRunNodeResult['gate'] => ({
      class: 'validate',
      input: 'right',
      valid,
      violatedRules: valid ? 0 : 1,
    })
    const mixed: PipelineRunResult = {
      status: 'completed',
      nodes: [
        dataNode('left', 'left', 5, 'view'),
        dataNode('right', 'right', 2, 'view'),
        dataNode('q1', 'right', 2, 'gate', gate(true)),
        dataNode('q2', 'right', 2, 'gate', gate(false)),
      ],
    }
    const derived = await deriveDcrArtifact(deriveInput({ run: mixed }))
    if (!derived.ok) throw new Error('expected derivation to succeed')
    expect(derived.validationValid).toBe(false)

    const passing: PipelineRunResult = {
      status: 'completed',
      nodes: [
        dataNode('left', 'left', 5, 'view'),
        dataNode('right', 'right', 2, 'view'),
        dataNode('q1', 'right', 2, 'gate', gate(true)),
        dataNode('q2', 'right', 2, 'gate', gate(true)),
      ],
    }
    const derived2 = await deriveDcrArtifact(deriveInput({ run: passing }))
    if (!derived2.ok) throw new Error('expected derivation to succeed')
    expect(derived2.validationValid).toBe(true)
  })

  it('says NO VERDICT honestly: no validate gates → no validation, null roll-up', async () => {
    const derived = await deriveDcrArtifact(deriveInput())
    expect(derived.ok).toBe(true)
    if (!derived.ok) return
    expect(derived.validationVerdicts).toBe(0)
    expect(derived.validationValid).toBe(null)
    expect(derived.artifact.validation).toBeUndefined()
  })

  it('refuses a canceled run as run-state (never derives from a canceled partial)', async () => {
    const canceled: PipelineRunResult = {
      status: 'canceled',
      nextNodeId: 'right',
      nodes: [dataNode('src', 'src', 5, 'source'), dataNode('left', 'left', 5, 'view')],
    }
    const derived = await deriveDcrArtifact(deriveInput({ run: canceled }))
    expect(derived).toMatchObject({ ok: false, kind: 'run-state', reason: 'run-canceled' })
  })
})

describe('deriveDcrArtifact — the D19-OQ-5 export-time liveness pin', () => {
  it('refuses loudly when a materialization reference dangles after derivation', async () => {
    // Calls 1–2 (the p3-2 derivations) succeed; from call 3 on (the explicit
    // export-time verification) the relation is gone. Removing the explicit
    // verification would let this derivation succeed — the pin fails.
    let calls = 0
    const schemaOf = async (relation: string) => {
      calls += 1
      if (calls >= 3) throw new Error('the relation was dropped')
      return unitSchemaOf(relation)
    }
    const derived = await deriveDcrArtifact(deriveInput({ schemaOf }))
    expect(derived).toEqual({
      ok: false,
      kind: 'run-state',
      reason: 'dangling-materialization',
      nodeId: 'left',
    })
  })

  it('refuses when a materialized relation introspects to an empty schema', async () => {
    const schemaOf = async (relation: string) =>
      relation === 'right' ? [] : unitSchemaOf(relation)
    const derived = await deriveDcrArtifact(deriveInput({ schemaOf }))
    expect(derived).toMatchObject({
      ok: false,
      kind: 'run-state',
      reason: 'dangling-materialization',
      nodeId: 'right',
    })
  })
})

describe('deriveDcrArtifact — reference refusals map to the CLI exit classes', () => {
  it('an unknown node is usage-class, naming the flag', async () => {
    const derived = await deriveDcrArtifact(deriveInput({ baseNodeId: 'ghost' }))
    expect(derived).toMatchObject({ ok: false, kind: 'usage' })
    if (derived.ok || derived.kind !== 'usage') return
    expect(derived.message).toContain('--base-node')
    expect(derived.message).toContain('ghost')
  })

  it('a source node is usage-class (sources are not dataset versions)', async () => {
    const derived = await deriveDcrArtifact(deriveInput({ baseNodeId: 'src' }))
    expect(derived).toMatchObject({ ok: false, kind: 'usage' })
    if (derived.ok || derived.kind !== 'usage') return
    expect(derived.message).toContain('not dataset versions')
  })

  it('a node the run never reached is usage-class (name a node the run executed)', async () => {
    const gatedRun: PipelineRunResult = {
      status: 'gated',
      gatedAt: 'quality',
      gate: 'validation-failed',
      nextNodeId: 'right',
      nodes: [
        dataNode('src', 'src', 5, 'source'),
        dataNode('left', 'left', 5, 'view'),
        dataNode('quality', 'left', 5, 'gate', {
          class: 'validate',
          input: 'left',
          valid: false,
          violatedRules: 1,
        }),
      ],
    }
    const derived = await deriveDcrArtifact(
      deriveInput({ run: gatedRun, candidateNodeId: 'right' }),
    )
    expect(derived).toMatchObject({ ok: false, kind: 'usage' })
    if (derived.ok || derived.kind !== 'usage') return
    expect(derived.message).toContain('did not execute in this run')
  })

  it('publish-mode materialization is refused at the DCR boundary (ADR 0033/0035)', async () => {
    const publishPlan: PipelineV1 = {
      version: 1,
      pipeline: 'publish_plan',
      nodes: [
        { id: 'src', type: 'source', source: { kind: 'file', path: 's.csv' } },
        {
          id: 'out',
          type: 'transform',
          inputs: ['src'],
          materialization: 'publish',
          operation: { operation: 'rename', args: { columns: { a: 'b' } } },
        },
      ],
    }
    const run: PipelineRunResult = {
      status: 'completed',
      nodes: [dataNode('src', 'src', 5, 'source')],
    }
    // The plan names 'out' (publish-mode) for the base: the declared-mode
    // guard fires before any run-state question. (The run above is
    // hand-built; the runner could never produce it — the guard is exactly
    // what keeps that impossible.)
    const derived = await deriveDcrArtifact(
      deriveInput({ plan: publishPlan, run, baseNodeId: 'out', candidateNodeId: 'src' }),
    )
    expect(derived).toMatchObject({ ok: false, kind: 'usage' })
    if (derived.ok || derived.kind !== 'usage') return
    expect(derived.message).toContain('publish')
  })

  it('a NUL-bearing dataset id is refused before any build (usage-class, value-free)', async () => {
    // datasetId is user data (the reserved namespace applies to node ids),
    // so the reachable id refusal is the p3-2 identity check — it fires
    // before the builder ever runs.
    const derived = await deriveDcrArtifact(deriveInput({ baseDatasetId: 'unit\u0000base' }))
    expect(derived).toMatchObject({ ok: false, kind: 'usage' })
    if (derived.ok || derived.kind !== 'usage') return
    expect(derived.message).toContain('non-empty NUL-free')
  })
})

describe('export report renderers — byte contracts', () => {
  const written: Parameters<typeof renderHumanDcrExportReport>[0] = {
    pipeline: 'unit_plan',
    runStatus: 'gated',
    gatedAt: 'quality',
    gate: 'validation-failed',
    refusal: null,
    base: { datasetId: 'unit_base', versionId: 'unit_base@abcd', node: 'left' },
    candidate: { datasetId: 'unit_candidate', versionId: 'unit_candidate@abcd', node: 'right' },
    schemaDriftFindings: 2,
    validationVerdicts: 1,
    validationValid: false,
    artifact: { file: 'artifact.yaml', bytes: 1234 },
  }

  it('renders the gated-written human report byte-exactly', () => {
    expect(renderHumanDcrExportReport(written, plainStyle)).toBe(
      [
        'pipeline: unit_plan',
        'run: gated — stopped at validation-failed gate "quality"',
        'base: unit_base (unit_base@abcd) — node "left"',
        'candidate: unit_candidate (unit_candidate@abcd) — node "right"',
        'schema drift: 2 findings carried',
        'validation: 1 verdict carried — invalid',
        'artifact: artifact.yaml — 1234 bytes — new file (never overwritten)',
        'verdict: GATED — the artifact is written; the run stopped at the gate, and the artifact carries exactly the evidence the run executed',
        '',
      ].join('\n'),
    )
  })

  it('says none-carried when no validate verdicts existed (never fabricates)', () => {
    const text = renderHumanDcrExportReport(
      { ...written, validationVerdicts: 0, validationValid: null },
      plainStyle,
    )
    expect(text).toContain('validation: none carried — the run executed no validate gates')
  })

  it('renders the dangling-materialization refusal (nothing written)', () => {
    const text = renderHumanDcrExportReport(
      {
        ...written,
        runStatus: 'gated',
        refusal: { reason: 'dangling-materialization', nodeId: 'left' },
        base: null,
        candidate: null,
        schemaDriftFindings: null,
        validationVerdicts: null,
        validationValid: null,
        artifact: null,
      },
      plainStyle,
    )
    expect(text).toContain(
      'verdict: REFUSED — the materialization reference for node "left" no longer resolves in the run session; nothing was written (dangling-materialization)',
    )
  })

  it('sanitizes hostile node ids in the refusal line (no raw control bytes)', () => {
    const text = renderHumanDcrExportReport(
      {
        ...written,
        refusal: { reason: 'dangling-materialization', nodeId: 'x\u001b[31my' },
        base: null,
        candidate: null,
        schemaDriftFindings: null,
        validationVerdicts: null,
        validationValid: null,
        artifact: null,
      },
      plainStyle,
    )
    // The escape is inert text (\u001b[…), never a raw control byte.
    expect(text).toContain('x\\u001b[31my')
    for (const char of text) {
      expect(char.codePointAt(0)).not.toBe(0x1b)
    }
  })

  it('renders the canceled/failed/refused run lines honestly', () => {
    const canceled = renderHumanDcrExportReport(
      {
        ...written,
        runStatus: 'canceled',
        gatedAt: null,
        gate: null,
        refusal: { reason: 'run-canceled', nodeId: null },
        base: null,
        candidate: null,
        schemaDriftFindings: null,
        validationVerdicts: null,
        validationValid: null,
        artifact: null,
      },
      plainStyle,
    )
    expect(canceled).toContain('run: canceled — abandoned before completion')
    expect(canceled).toContain('verdict: REFUSED — the run was canceled; nothing was written')
    const failed = renderHumanDcrExportReport(
      {
        ...written,
        runStatus: 'failed',
        gatedAt: null,
        gate: null,
        refusal: { reason: 'run-failed', nodeId: 'broken' },
        base: null,
        candidate: null,
        schemaDriftFindings: null,
        validationVerdicts: null,
        validationValid: null,
        artifact: null,
      },
      plainStyle,
    )
    expect(failed).toContain('run: failed — a node could not be materialized')
    expect(failed).toContain('verdict: REFUSED — the run failed; nothing was written')
    const refused = renderHumanDcrExportReport(
      {
        ...written,
        runStatus: 'refused',
        gatedAt: null,
        gate: null,
        refusal: { reason: 'run-refused', nodeId: null },
        base: null,
        candidate: null,
        schemaDriftFindings: null,
        validationVerdicts: null,
        validationValid: null,
        artifact: null,
      },
      plainStyle,
    )
    expect(refused).toContain('run: refused — nothing was executed')
    expect(refused).toContain(
      'verdict: REFUSED — the run was refused before execution; nothing was written',
    )
  })

  it('renders the JSON refusal branch with the typed reason', () => {
    const json = renderJsonDcrExportReport({
      ...written,
      refusal: { reason: 'dangling-materialization', nodeId: 'left' },
      base: null,
      candidate: null,
      schemaDriftFindings: null,
      validationVerdicts: null,
      validationValid: null,
      artifact: null,
    })
    const parsed = JSON.parse(json) as {
      refusal: { reason: string; nodeId: string | null }
      artifact: unknown
    }
    expect(parsed.refusal).toEqual({ reason: 'dangling-materialization', nodeId: 'left' })
    expect(parsed.artifact).toBe(null)
  })

  it('renders the JSON envelope with the fixed key order and stamp', () => {
    const json = renderJsonDcrExportReport(written)
    const parsed = JSON.parse(json) as Record<string, unknown>
    expect(parsed['report']).toBe('assay-dcr-export')
    expect(parsed['reportVersion']).toBe(REPORT_VERSION)
    expect(Object.keys(parsed)).toEqual([
      'report',
      'reportVersion',
      'pipeline',
      'runStatus',
      'gatedAt',
      'gate',
      'refusal',
      'base',
      'candidate',
      'schemaDriftFindings',
      'validationVerdicts',
      'validationValid',
      'artifact',
    ])
    expect(json.endsWith('\n')).toBe(true)
    expect(json).not.toMatch(/\/tmp\//) // paths stay out of stdout (basename only)
  })

  it('keeps dataset values out of every message (ADR 0025)', async () => {
    const derived = await deriveDcrArtifact(
      deriveInput({ baseNodeId: 'src', candidateNodeId: 'right' }),
    )
    const messages: string[] = []
    if (!derived.ok) {
      if (derived.kind === 'usage') messages.push(derived.message)
    }
    // The plan's source path is authored content that must never leak.
    for (const message of messages) expect(message).not.toContain('secret-dataset.csv')
  })
})

describe('runDcrCommand — the pre-engine arms (no connection is ever opened)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'assay-dcr-cmd-'))
  /** A capturing context: stdout/stderr recorded, progress silent. */
  function capture(): { readonly context: CommandContext; readonly stdout: () => string } {
    const chunks: string[] = []
    return {
      context: {
        out: (text) => {
          chunks.push(text)
        },
        style: plainStyle,
        progress: { enabled: false, step: () => {}, done: () => {} },
      },
      stdout: () => chunks.join(''),
    }
  }

  function options(pipelinePath: string, overrides?: Partial<DcrOptions>): DcrOptions {
    return {
      pipelinePath,
      outPath: join(tmpdir(), `assay-dcr-cmd-${String(process.pid)}.yaml`),
      baseNodeId: 'left',
      baseDatasetId: 'b',
      candidateNodeId: 'right',
      candidateDatasetId: 'c',
      format: 'human',
      keys: [],
      ...overrides,
    }
  }

  it('refuses an existing --out before anything runs (ADR 0012 pre-flight)', async () => {
    const existing = join(dir, 'already-there.yaml')
    writeFileSync(existing, 'do not touch\n')
    const pipeline = join(dir, 'cmd-valid.yaml')
    writeFileSync(
      pipeline,
      [
        'version: 1',
        'pipeline: cmd_valid',
        'nodes:',
        '  a:',
        '    type: source',
        '    source:',
        '      kind: file',
        '      path: ./no-such-dataset.csv',
        '  b:',
        '    type: transform',
        '    inputs: [a]',
        '    operation:',
        '      rename:',
        '        columns:',
        '          customer_id: customer_ref',
      ].join('\n'),
    )
    const { context } = capture()
    await expect(runDcrCommand(options(pipeline, { outPath: existing }), context)).rejects.toThrow(
      'never overwritten',
    )
    expect(readFileSync(existing, 'utf8')).toBe('do not touch\n')
  })

  it('refuses an unreadable pipeline file', async () => {
    const { context } = capture()
    await expect(
      runDcrCommand(options(join(dir, 'no-such-pipeline.yaml')), context),
    ).rejects.toThrow('pipeline file not readable')
  })

  it('reports a malformed IR with located errors (exit 2)', async () => {
    const malformed = join(dir, 'cmd-malformed.yaml')
    writeFileSync(malformed, 'version: 1\npipeline: broken\nnodes: [ unclosed\n')
    const { context } = capture()
    await expect(runDcrCommand(options(malformed), context)).rejects.toThrow(
      'pipeline could not be parsed',
    )
  })

  it('renders the validate report for a structurally broken DAG (exit 1, nothing executed)', async () => {
    const dagBroken = join(dir, 'cmd-dag-broken.yaml')
    writeFileSync(
      dagBroken,
      [
        'version: 1',
        'pipeline: cmd_dag_broken',
        'nodes:',
        '  a:',
        '    type: sql',
        '    inputs: [ghost]',
        '    sql: SELECT 1',
      ].join('\n'),
    )
    const { context, stdout } = capture()
    const exit = await runDcrCommand(options(dagBroken), context)
    expect(exit).toBe(1)
    expect(stdout()).toContain('INVALID')
  })

  it('refuses unresolvable validate-node contracts before any execution (exit 2)', async () => {
    const missingContract = join(dir, 'cmd-missing-contract.yaml')
    writeFileSync(
      missingContract,
      [
        'version: 1',
        'pipeline: cmd_missing_contract',
        'nodes:',
        '  a:',
        '    type: source',
        '    source:',
        '      kind: file',
        '      path: ./no-such-dataset.csv',
        '  q:',
        '    type: validate',
        '    input: a',
        '    contract: contracts/missing.yaml',
      ].join('\n'),
    )
    const { context } = capture()
    await expect(runDcrCommand(options(missingContract), context)).rejects.toThrow(
      'dcr gates could not be resolved',
    )
  })

  it('refuses an unbound diff key before any execution (C2, exit 2)', async () => {
    const diffNoKeys = join(dir, 'cmd-diff-no-keys.yaml')
    writeFileSync(
      diffNoKeys,
      [
        'version: 1',
        'pipeline: cmd_diff_no_keys',
        'nodes:',
        '  a:',
        '    type: source',
        '    source:',
        '      kind: file',
        '      path: ./no-such-dataset.csv',
        '  cmp:',
        '    type: diff',
        '    input: a',
        '    against: a',
      ].join('\n'),
    )
    const { context } = capture()
    // The source also does not resolve — both refusals are collected; the
    // gate-binding refusal fires because the diff node has no keys.
    await expect(runDcrCommand(options(diffNoKeys), context)).rejects.toThrow(
      /could not be (resolved|executed)/,
    )
  })
})
