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
    })
    expect(resolvePipelineOptions({ format: 'json', positionals: ['run', 'p.yaml'] })).toEqual({
      subcommand: 'run',
      pipelinePath: 'p.yaml',
      format: 'json',
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
    expect(() =>
      resolvePipelineOptions({ keys: ['id'], positionals: ['validate', 'p.yaml'] }),
    ).toThrow('pipeline does not take --key (did you mean `assay diff`? see --help)')
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
      { subcommand: 'validate', pipelinePath: path, format: 'human' },
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
      { subcommand: 'validate', pipelinePath: path, format: 'human' },
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
      { subcommand: 'validate', pipelinePath: GOLDEN_PIPELINE, format: 'json' },
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
      { subcommand: 'run', pipelinePath: GOLDEN_PIPELINE, format: 'json' },
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
      { subcommand: 'run', pipelinePath: path, format: 'human' },
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
      { subcommand: 'run', pipelinePath: path, format: 'human' },
      context,
    )
    expect(code).toBe(1)
    expect(context.output()).toContain('2. broken — sql — FAILED')
    expect(context.output()).toContain('verdict: FAILED — node "broken" could not be materialized')
  }, 60_000)

  it('a run refusal (DAG-invalid pipeline) exits 1 and executes nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'assay-p-4-unit-'))
    const path = join(dir, 'refusal.yaml')
    writeFileSync(
      path,
      'version: 1\npipeline: compile_refusal\nnodes:\n  a:\n    type: source\n    source:\n      kind: file\n      path: ./x.csv\n  gate:\n    type: validate\n    input: a\n    contract: contracts/x.yaml\n',
    )
    const context = captureContext()
    const code = await runPipelineCommand(
      { subcommand: 'run', pipelinePath: path, format: 'human' },
      context,
    )
    expect(code).toBe(1)
    expect(context.output()).toContain('verdict: INVALID — 1 error')
  })
})
