// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for the p-4 pipeline command module: option resolution (the
 * two-level subcommand, cross-command flag rejection, the no-infer rule) and
 * the command runner's outcome classes — in-process, with a capturing
 * output context, including a REAL engine execution of the golden runnable
 * fixture through the `./node` ops binding (the spawned integration suite
 * pins the CLI's bytes; these tests pin the runner's in-process behavior and
 * keep the new surface inside the coverage denominator).
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runPipelineCommand, resolvePipelineOptions } from './pipeline.js'
import { CliError } from './errors.js'
import { silentProgress } from './progress.js'
import { plainStyle } from './style.js'
import type { CommandContext } from './context.js'

const CLI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_DIR = join(CLI_DIR, '..', '..')
const GOLDEN_PIPELINE = join(REPO_DIR, 'fixtures', 'pipeline', 'cli_run.yaml')
const GOLDEN_GATED = join(REPO_DIR, 'fixtures', 'pipeline', 'cli_gated.yaml')
const GOLDEN_GATED_PASS = join(REPO_DIR, 'fixtures', 'pipeline', 'cli_gated_pass.yaml')
const GOLDEN_DATASET = join(REPO_DIR, 'fixtures', 'csv', 'customers.csv')

/** A capturing command context (no telemetry — the runner must not need it). */
function captureContext(): CommandContext & { readonly output: () => string } {
  let captured = ''
  return {
    out: (text) => {
      captured += text
    },
    style: plainStyle,
    progress: silentProgress,
    output: () => captured,
  }
}

describe('resolvePipelineOptions', () => {
  it('resolves the two-level subcommand with defaults', () => {
    expect(resolvePipelineOptions({ positionals: ['validate', 'p.yaml'] })).toEqual({
      subcommand: 'validate',
      pipelinePath: 'p.yaml',
      format: 'human',
      keys: [],
    })
    expect(resolvePipelineOptions({ format: 'json', positionals: ['run', 'p.yaml'] })).toEqual({
      subcommand: 'run',
      pipelinePath: 'p.yaml',
      format: 'json',
      keys: [],
    })
  })

  it('rejects a missing/unknown subcommand and a missing/extra file (exit 2)', () => {
    expect(() => resolvePipelineOptions({ positionals: [] })).toThrow(CliError)
    expect(() => resolvePipelineOptions({ positionals: [] })).toThrow(
      'pipeline requires a subcommand: validate or run (see --help)',
    )
    expect(() => resolvePipelineOptions({ positionals: ['frobnicate'] })).toThrow(
      "unknown pipeline subcommand 'frobnicate' (expected validate or run; see --help)",
    )
    expect(() => resolvePipelineOptions({ positionals: ['validate'] })).toThrow(
      'pipeline validate requires a pipeline file path (see --help)',
    )
    expect(() => resolvePipelineOptions({ positionals: ['run', 'a.yaml', 'b.yaml'] })).toThrow(
      'pipeline run takes exactly one pipeline file path (got 2)',
    )
  })

  it('rejects cross-command flags instead of silently ignoring them (exit 2)', () => {
    expect(() =>
      resolvePipelineOptions({ contract: 'c.yaml', positionals: ['validate', 'p.yaml'] }),
    ).toThrow('pipeline does not take --contract (did you mean `assay validate`? see --help)')
    // `--key` IS accepted: the explicit C2 diff key set (never inferred).
    expect(resolvePipelineOptions({ keys: ['id'], positionals: ['run', 'p.yaml'] })).toEqual({
      subcommand: 'run',
      pipelinePath: 'p.yaml',
      format: 'human',
      keys: ['id'],
    })
    expect(() => resolvePipelineOptions({ infer: true, positionals: ['run', 'p.yaml'] })).toThrow(
      'pipeline does not take --infer — a pipeline is executed exactly as authored (see --help)',
    )
    expect(() =>
      resolvePipelineOptions({ sampleLimit: '5', positionals: ['validate', 'p.yaml'] }),
    ).toThrow('pipeline does not take --sample-limit (see --help)')
    expect(() =>
      resolvePipelineOptions({ format: 'xml', positionals: ['validate', 'p.yaml'] }),
    ).toThrow("--format must be 'human' or 'json' (got 'xml')")
  })
})

describe('runPipelineCommand — validate (no execution, no source resolution)', () => {
  it('a valid pipeline exits 0 and renders the plan (sources never touched)', () => {
    // The pipeline names sources that DO NOT EXIST — validate must still
    // succeed: it never resolves or opens datasets (C2 boundary is run-only).
    const context = captureContext()
    const exit = runPipelineCommand(
      {
        subcommand: 'validate',
        pipelinePath: GOLDEN_PIPELINE,
        format: 'human',
        keys: [],
      },
      context,
    )
    return exit.then((code) => {
      expect(code).toBe(0)
      expect(context.output()).toContain(
        'verdict: VALID — the DAG validates and the plan compiles (nothing was executed)',
      )
    })
  })

  it('a DAG-invalid pipeline exits 1 with the report as the result', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'assay-p-4-unit-'))
    const path = join(dir, 'dag-error.yaml')
    writeFileSync(
      path,
      'version: 1\npipeline: dag_error\nnodes:\n  a:\n    type: sql\n    inputs: [ghost]\n    sql: SELECT 1\n',
    )
    const context = captureContext()
    const code = await runPipelineCommand(
      { subcommand: 'validate', pipelinePath: path, format: 'human', keys: [] },
      context,
    )
    expect(code).toBe(1)
    expect(context.output()).toContain('verdict: INVALID — 1 error')
  })

  it('a malformed pipeline throws the located, sanitized parse error (exit 2)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'assay-p-4-unit-'))
    const path = join(dir, 'malformed.yaml')
    writeFileSync(path, 'version: 1\npipeline: broken\nnodes: [ unclosed\n')
    const context = captureContext()
    const error = await runPipelineCommand(
      { subcommand: 'validate', pipelinePath: path, format: 'human', keys: [] },
      context,
    ).then(
      () => null,
      (error: unknown) => error,
    )
    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).exitCode).toBe(2)
    expect((error as CliError).message.startsWith('pipeline could not be parsed:')).toBe(true)
    expect(context.output()).toBe('')
  })

  it('the json format renders the envelope', async () => {
    const context = captureContext()
    await runPipelineCommand(
      { subcommand: 'validate', pipelinePath: GOLDEN_PIPELINE, format: 'json', keys: [] },
      context,
    )
    const payload = JSON.parse(context.output()) as { report: string; valid: boolean }
    expect(payload.report).toBe('assay-pipeline-validate-report')
    expect(payload.valid).toBe(true)
  })
})

describe('runPipelineCommand — run (real engine, in-process)', () => {
  it('executes the golden fixture end-to-end: exit 0, per-node counts, outputs', async () => {
    const context = captureContext()
    const code = await runPipelineCommand(
      { subcommand: 'run', pipelinePath: GOLDEN_PIPELINE, format: 'json', keys: [] },
      context,
    )
    expect(code).toBe(0)
    const payload = JSON.parse(context.output()) as {
      report: string
      status: string
      nodes: { nodeId: string; status: string; rowCount: number }[]
      outputs: { relation: string; rowCount: number }[]
    }
    expect(payload.report).toBe('assay-pipeline-run-report')
    expect(payload.status).toBe('completed')
    expect(payload.nodes.map((node) => [node.nodeId, node.status, node.rowCount])).toEqual([
      ['customers', 'materialized', 5],
      ['renamed', 'materialized', 5],
      ['sg_only', 'materialized', 2],
      ['by_country', 'materialized', 1],
    ])
    expect(payload.outputs).toEqual([{ nodeId: 'by_country', relation: 'by_country', rowCount: 1 }])
  }, 60_000)

  it('an unresolvable source discloses and refuses before any execution (exit 2)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'assay-p-4-unit-'))
    const path = join(dir, 'missing-source.yaml')
    writeFileSync(
      path,
      'version: 1\npipeline: missing_source\nnodes:\n  a:\n    type: source\n    source:\n      kind: file\n      path: ./datasets/missing.csv\n',
    )
    const context = captureContext()
    const error = await runPipelineCommand(
      { subcommand: 'run', pipelinePath: path, format: 'human', keys: [] },
      context,
    ).then(
      () => null,
      (error: unknown) => error,
    )
    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).exitCode).toBe(2)
    expect((error as CliError).message).toContain(
      'pipeline sources could not be resolved (nothing was executed):',
    )
    expect(context.output()).toBe('')
  })

  it('a mid-run node failure resolves as exit 1 with the failing node named', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'assay-p-4-unit-'))
    const path = join(dir, 'node-failure.yaml')
    writeFileSync(
      path,
      `version: 1
pipeline: node_failure
nodes:
  a:
    type: source
    source:
      kind: file
      path: ${JSON.stringify(GOLDEN_DATASET)}
  broken:
    type: sql
    inputs: [a]
    sql: SELECT no_such_column FROM a
`,
    )
    const context = captureContext()
    const code = await runPipelineCommand(
      { subcommand: 'run', pipelinePath: path, format: 'human', keys: [] },
      context,
    )
    expect(code).toBe(1)
    expect(context.output()).toContain('2. broken — sql — FAILED')
    expect(context.output()).toContain('verdict: FAILED — node "broken" could not be materialized')
  }, 60_000)

  it('a missing validate contract refuses at exit 2 before any execution (C2)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'assay-p-4-unit-'))
    const path = join(dir, 'missing-contract.yaml')
    writeFileSync(
      path,
      'version: 1\npipeline: missing_contract\nnodes:\n  a:\n    type: source\n    source:\n      kind: file\n      path: ./x.csv\n  gate:\n    type: validate\n    input: a\n    contract: contracts/x.yaml\n',
    )
    const context = captureContext()
    const error = await runPipelineCommand(
      { subcommand: 'run', pipelinePath: path, format: 'human', keys: [] },
      context,
    ).then(
      () => null,
      (error: unknown) => error,
    )
    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).exitCode).toBe(2)
    expect((error as CliError).message).toContain(
      'pipeline gates could not be resolved (nothing was executed):',
    )
    expect((error as CliError).message).toContain('gate: contract file not found:')
    expect(context.output()).toBe('')
  })
})

describe('runPipelineCommand — p2-5 gates (real engine, in-process)', () => {
  it('a failing validate gate is a gated result (exit 1), not a crash', async () => {
    const context = captureContext()
    const code = await runPipelineCommand(
      { subcommand: 'run', pipelinePath: GOLDEN_GATED, format: 'json', keys: [] },
      context,
    )
    expect(code).toBe(1)
    const payload = JSON.parse(context.output()) as {
      status: string
      gatedAt: string
      gate: string
      nodes: { nodeId: string; status: string; gate: { valid: boolean } | null }[]
    }
    expect(payload.status).toBe('gated')
    expect(payload.gatedAt).toBe('quality')
    expect(payload.gate).toBe('validation-failed')
    expect(payload.nodes.map((node) => [node.nodeId, node.status])).toEqual([
      ['customers', 'materialized'],
      ['sg_only', 'materialized'],
      ['quality', 'gated'],
    ])
    expect(payload.nodes[2]?.gate?.valid).toBe(false)
  }, 60_000)

  it('the passing variant completes (exit 0)', async () => {
    const context = captureContext()
    const code = await runPipelineCommand(
      { subcommand: 'run', pipelinePath: GOLDEN_GATED_PASS, format: 'json', keys: [] },
      context,
    )
    expect(code).toBe(0)
    const payload = JSON.parse(context.output()) as {
      status: string
      nodes: { nodeId: string; status: string }[]
    }
    expect(payload.status).toBe('completed')
    expect(payload.nodes[2]?.status).toBe('passed')
  }, 60_000)

  it('a diff node runs with an explicit key set (the M6 gate path)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'assay-p2-5-unit-'))
    const path = join(dir, 'diff.yaml')
    writeFileSync(
      path,
      `version: 1
pipeline: diff_pipeline
nodes:
  a:
    type: source
    source:
      kind: file
      path: ${JSON.stringify(GOLDEN_DATASET)}
  sg:
    type: transform
    inputs: [a]
    operation:
      filter:
        predicates:
          - column: country
            operator: equals
            value: SG
  compare:
    type: diff
    input: sg
    against: a
`,
    )
    const context = captureContext()
    const code = await runPipelineCommand(
      { subcommand: 'run', pipelinePath: path, format: 'json', keys: ['customer_id'] },
      context,
    )
    expect(code).toBe(0)
    const payload = JSON.parse(context.output()) as {
      status: string
      nodes: { nodeId: string; status: string; gate: { class: string } | null }[]
    }
    expect(payload.status).toBe('completed')
    const compare = payload.nodes.find((node) => node.nodeId === 'compare')
    expect(compare?.status).toBe('passed')
    expect(compare?.gate?.class).toBe('diff')
  }, 60_000)

  it('an export-mode node is a typed refusal (the runner refusal is not internal)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'assay-p2-5-unit-'))
    const path = join(dir, 'export.yaml')
    writeFileSync(
      path,
      `version: 1
pipeline: export_pipeline
nodes:
  a:
    type: source
    source:
      kind: file
      path: ${JSON.stringify(GOLDEN_DATASET)}
  exp:
    type: transform
    inputs: [a]
    materialization: export
    operation:
      rename:
        columns:
          customer_id: customer_ref
`,
    )
    const context = captureContext()
    const code = await runPipelineCommand(
      { subcommand: 'run', pipelinePath: path, format: 'json', keys: [] },
      context,
    )
    expect(code).toBe(1)
    const payload = JSON.parse(context.output()) as {
      status: string
      refusal: string
      refusalNode: string
    }
    expect(payload.status).toBe('refused')
    expect(payload.refusal).toBe('unsupported-materialization')
    expect(payload.refusalNode).toBe('exp')
  }, 60_000)

  it('validate gate-visibility discloses a missing contract as a would-fail', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'assay-p2-5-unit-'))
    const path = join(dir, 'missing-contract.yaml')
    writeFileSync(
      path,
      `version: 1
pipeline: missing_contract
nodes:
  a:
    type: source
    source:
      kind: file
      path: ${JSON.stringify(GOLDEN_DATASET)}
  gate:
    type: validate
    input: a
    contract: contracts/x.yaml
`,
    )
    const context = captureContext()
    const code = await runPipelineCommand(
      { subcommand: 'validate', pipelinePath: path, format: 'json', keys: [] },
      context,
    )
    expect(code).toBe(1)
    const payload = JSON.parse(context.output()) as {
      valid: boolean
      gateErrors: string[]
      gates: { nodeId: string; bound: boolean; contractStatus: string }[]
    }
    expect(payload.valid).toBe(false)
    expect(payload.gateErrors).toHaveLength(1)
    expect(payload.gates[0]).toMatchObject({
      nodeId: 'gate',
      bound: false,
      contractStatus: 'missing',
    })
  })

  it('validate gate-visibility discloses an unbound diff key as a would-fail', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'assay-p2-5-unit-'))
    const path = join(dir, 'diff-nokey.yaml')
    writeFileSync(
      path,
      `version: 1
pipeline: diff_nokey
nodes:
  a:
    type: source
    source:
      kind: file
      path: ${JSON.stringify(GOLDEN_DATASET)}
  b:
    type: source
    source:
      kind: file
      path: ${JSON.stringify(GOLDEN_DATASET)}
  compare:
    type: diff
    input: a
    against: b
`,
    )
    const context = captureContext()
    const code = await runPipelineCommand(
      { subcommand: 'validate', pipelinePath: path, format: 'human', keys: [] },
      context,
    )
    expect(code).toBe(1)
    expect(context.output()).toContain('compare — diff — against "b" (keys not bound)')
    expect(context.output()).toContain(
      'compare: a diff node requires an explicit key set (--key <column>); keys are never inferred',
    )
  })
})
