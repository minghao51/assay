// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Integration tests for `assay dcr` (p3-3): every test SPAWNS the COMPILED
 * CLI (`node --import tsx dist/index.js …`, ADR 0042) — the pipeline
 * integration pattern — against the golden gated pipeline
 * `fixtures/pipeline/cli_dcr_gated.yaml` and its completed-run twin
 * `cli_dcr_pass.yaml` (real Node-engine runs, not mocks).
 *
 * Pins:
 * - the GOLDEN ARTIFACT byte pin: the gated journey's written bytes are
 *   EXACTLY the committed repo golden `fixtures/dcr/cli-gated-run.yaml`
 *   (minted through this same code path, manifest-checksummed beside the
 *   p3-1 corpus), which itself round-trips through `parseDcr` →
 *   `serializeDcr` byte-identically — CLI bytes ≡ serializer bytes ≡ golden;
 * - run-to-run byte stability (no wall-clock — D17-Q11);
 * - the ADR 0012 no-rewrite refusal end-to-end (exit 2, file untouched);
 * - the exit classes: 0 written/completed, 1 written/gated (the report on
 *   stdout discloses it — the p2-5 result discipline), 2 usage/refusals;
 * - value-free output (ADR 0025): no dataset cell value appears anywhere.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDcr, serializeDcr } from '@assay/pipeline'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const CLI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_DIR = join(CLI_DIR, '..', '..')
const GOLDEN_GATED = join(REPO_DIR, 'fixtures', 'pipeline', 'cli_dcr_gated.yaml')
const GOLDEN_COMPLETED = join(REPO_DIR, 'fixtures', 'pipeline', 'cli_dcr_pass.yaml')
const GOLDEN_DATASET = join(REPO_DIR, 'fixtures', 'csv', 'customers.csv')
const FAIL_CONTRACT = join(REPO_DIR, 'fixtures', 'pipeline', 'contracts', 'sg_min_rows_fail.yaml')
const COMMITTED_GOLDEN = join(REPO_DIR, 'fixtures', 'dcr', 'cli-gated-run.yaml')

/** The package's own version — the `--version` single source of truth (q-4). */
const PACKAGE_VERSION = (
  JSON.parse(readFileSync(join(CLI_DIR, 'package.json'), 'utf8')) as { version: string }
).version

interface CliRun {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/** Spawn the compiled CLI (ADR 0042): `node --import tsx dist/index.js …`. */
function runCli(args: readonly string[]): CliRun {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'dist/index.js', ...args], {
    cwd: CLI_DIR,
    encoding: 'utf8',
  })
  return { exitCode: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

let dir: string
const out = (name: string): string => join(dir, name)

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'assay-p3-3-'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('assay dcr — the golden gated end-to-end journey', () => {
  const args = (outPath: string): string[] => [
    'dcr',
    GOLDEN_GATED,
    '--out',
    outPath,
    '--base-node',
    'renamed',
    '--base-dataset-id',
    'customers_base',
    '--candidate-node',
    'by_country',
    '--candidate-dataset-id',
    'customers_by_country',
  ]

  it('writes the artifact off the gated run and exits 1 (a result, not a crash)', () => {
    const run = runCli(args(out('golden-journey.yaml')))
    expect(run.exitCode).toBe(1)
    expect(run.stdout).toContain('run: gated — stopped at validation-failed gate "quality"')
    expect(run.stdout).toContain('artifact: golden-journey.yaml — ')
    expect(run.stdout).toContain('new file (never overwritten)')
  })

  it('CLI bytes ≡ serializeDcr(parseDcr(bytes)) ≡ the committed golden bytes', () => {
    const outPath = out('golden-bytes.yaml')
    const run = runCli(args(outPath))
    expect(run.exitCode).toBe(1)
    const cliBytes = readFileSync(outPath)
    const committed = readFileSync(COMMITTED_GOLDEN)
    expect(cliBytes.equals(committed)).toBe(true)
    const parsed = parseDcr(cliBytes.toString('utf8'))
    expect(parsed.ok).toBe(true)
    if (parsed.ok)
      expect(Buffer.from(serializeDcr(parsed.artifact), 'utf8').equals(cliBytes)).toBe(true)
  })

  it('is byte-stable across runs (no wall-clock in the canonical bytes)', () => {
    const first = out('stable-1.yaml')
    const second = out('stable-2.yaml')
    expect(runCli(args(first)).exitCode).toBe(1)
    expect(runCli(args(second)).exitCode).toBe(1)
    expect(readFileSync(first).equals(readFileSync(second))).toBe(true)
  })

  it('refuses an existing --out before running anything (ADR 0012, exit 2)', () => {
    const outPath = out('golden-journey.yaml') // written by the first test
    const before = readFileSync(outPath)
    const run = runCli(args(outPath))
    expect(run.exitCode).toBe(2)
    expect(run.stderr).toContain('never overwritten')
    expect(run.stderr).toContain('ADR 0012')
    expect(run.stdout).toBe('')
    expect(readFileSync(outPath).equals(before)).toBe(true)
  })

  it('is value-free: no dataset cell value reaches stdout or stderr (ADR 0025)', () => {
    const outPath = out('value-free.yaml')
    const run = runCli(args(outPath))
    expect(run.exitCode).toBe(1)
    for (const text of [run.stdout, run.stderr, readFileSync(outPath, 'utf8')]) {
      expect(text).not.toContain('SG')
      expect(text).not.toContain('52000')
      expect(text).not.toContain('2025-01-04')
      expect(text).not.toContain('C1')
    }
  })

  it('renders the JSON envelope with the fixed key order and honest roll-up', () => {
    const outPath = out('golden-json.yaml')
    const run = runCli([...args(outPath), '--format', 'json'])
    expect(run.exitCode).toBe(1)
    const payload = JSON.parse(run.stdout) as Record<string, unknown>
    expect(Object.keys(payload)).toEqual([
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
    expect(payload['report']).toBe('assay-dcr-export')
    expect(payload['reportVersion']).toBe(PACKAGE_VERSION)
    expect(payload['runStatus']).toBe('gated')
    expect(payload['gatedAt']).toBe('quality')
    expect(payload['gate']).toBe('validation-failed')
    expect(payload['validationVerdicts']).toBe(1)
    expect(payload['validationValid']).toBe(false)
    expect(payload['refusal']).toBe(null)
    const artifact = payload['artifact'] as { file: string; bytes: number }
    expect(artifact.file).toBe('golden-json.yaml')
    expect(artifact.bytes).toBe(readFileSync(outPath).byteLength)
  })

  it('carries the failed gate honestly in the artifact itself', () => {
    const text = readFileSync(COMMITTED_GOLDEN, 'utf8')
    expect(text).toContain('validation:')
    expect(text).toMatch(/- nodeId: quality\n/)
    expect(text).toMatch(/valid: false\n/)
    // …and the derived provenance/schema facts (schema, never values).
    expect(text).toContain('transformationRecipe: cli_dcr_gated|by_country')
    expect(text).toContain('algorithm: assay-schema-fingerprint-v1')
  })
})

describe('assay dcr — the completed-run journey (exit 0)', () => {
  it('writes the artifact off the completed run and exits 0', () => {
    const outPath = out('completed.yaml')
    const run = runCli([
      'dcr',
      GOLDEN_COMPLETED,
      '--out',
      outPath,
      '--base-node',
      'renamed',
      '--base-dataset-id',
      'customers_base',
      '--candidate-node',
      'by_country',
      '--candidate-dataset-id',
      'customers_by_country',
    ])
    expect(run.exitCode).toBe(0)
    expect(run.stdout).toContain('run: completed')
    expect(run.stdout).toContain('validation: 1 verdict carried — valid')
    expect(run.stdout).toContain('verdict: WRITTEN')
    expect(readFileSync(outPath).byteLength).toBeGreaterThan(0)
  })
})

describe('assay dcr — usage and resolution refusals (exit 2, nothing written)', () => {
  it('refuses a missing --out', () => {
    const run = runCli([
      'dcr',
      GOLDEN_GATED,
      '--base-node',
      'renamed',
      '--base-dataset-id',
      'b',
      '--candidate-node',
      'by_country',
      '--candidate-dataset-id',
      'c',
    ])
    expect(run.exitCode).toBe(2)
    expect(run.stderr).toContain('dcr requires --out <path>')
  })

  it('refuses the same node for both sides', () => {
    const run = runCli([
      'dcr',
      GOLDEN_GATED,
      '--out',
      out('x1.yaml'),
      '--base-node',
      'renamed',
      '--base-dataset-id',
      'b',
      '--candidate-node',
      'renamed',
      '--candidate-dataset-id',
      'c',
    ])
    expect(run.exitCode).toBe(2)
    expect(run.stderr).toContain('must be different nodes')
  })

  it('refuses an unknown node (usage-class, naming the flag)', () => {
    const run = runCli([
      'dcr',
      GOLDEN_GATED,
      '--out',
      out('x2.yaml'),
      '--base-node',
      'ghost',
      '--base-dataset-id',
      'b',
      '--candidate-node',
      'by_country',
      '--candidate-dataset-id',
      'c',
    ])
    expect(run.exitCode).toBe(2)
    expect(run.stderr).toContain('--base-node')
    expect(run.stderr).toContain('not a data node')
  })

  it('refuses a source node as a version (sources are not dataset versions)', () => {
    const run = runCli([
      'dcr',
      GOLDEN_GATED,
      '--out',
      out('x3.yaml'),
      '--base-node',
      'customers',
      '--base-dataset-id',
      'b',
      '--candidate-node',
      'by_country',
      '--candidate-dataset-id',
      'c',
    ])
    expect(run.exitCode).toBe(2)
    expect(run.stderr).toContain('not dataset versions')
  })

  it('refuses an unresolvable source before any execution (C2 collect-all)', () => {
    const pipeline = [
      'version: 1',
      'pipeline: dcr_missing_source',
      'nodes:',
      '  a:',
      '    type: source',
      '    source:',
      '      kind: file',
      '      path: ./datasets/missing.csv',
      '  b:',
      '    type: transform',
      '    inputs: [a]',
      '    operation:',
      '      rename:',
      '        columns:',
      '          customer_id: customer_ref',
    ].join('\n')
    const pipelinePath = out('missing-source.yaml')
    writeFileSync(pipelinePath, pipeline)
    const run = runCli([
      'dcr',
      pipelinePath,
      '--out',
      out('x4.yaml'),
      '--base-node',
      'b',
      '--base-dataset-id',
      'b',
      '--candidate-node',
      'a',
      '--candidate-dataset-id',
      'c',
    ])
    expect(run.exitCode).toBe(2)
    expect(run.stderr).toContain('could not be resolved')
    expect(run.stderr).toContain('dataset file not found')
  })

  it('refuses a diff node without an explicit key set (C2: never inferred)', () => {
    const pipeline = [
      'version: 1',
      'pipeline: dcr_diff_no_keys',
      'nodes:',
      '  a:',
      '    type: source',
      '    source:',
      '      kind: file',
      `      path: ${GOLDEN_DATASET}`,
      '  a2:',
      '    type: transform',
      '    inputs: [a]',
      '    operation:',
      '      rename:',
      '        columns:',
      '          customer_id: customer_ref',
      '  cmp:',
      '    type: diff',
      '    input: a2',
      '    against: a',
    ].join('\n')
    const pipelinePath = out('diff-no-keys.yaml')
    writeFileSync(pipelinePath, pipeline)
    const run = runCli([
      'dcr',
      pipelinePath,
      '--out',
      out('x5.yaml'),
      '--base-node',
      'a2',
      '--base-dataset-id',
      'b',
      '--candidate-node',
      'a',
      '--candidate-dataset-id',
      'c',
    ])
    expect(run.exitCode).toBe(2)
    expect(run.stderr).toContain('requires an explicit key set')
  })

  it('refuses a candidate node the gated run never reached (honest refusal)', () => {
    // The gate stops the run before `renamed`/`tail` execute: quality sits
    // between sg_only (2 rows) and the renamed chain, and its contract
    // requires 3 rows.
    const pipeline = [
      'version: 1',
      'pipeline: dcr_post_gate',
      'nodes:',
      '  customers:',
      '    type: source',
      '    source:',
      '      kind: file',
      `      path: ${GOLDEN_DATASET}`,
      '  sg_only:',
      '    type: transform',
      '    inputs: [customers]',
      '    operation:',
      '      filter:',
      '        predicates:',
      '          - column: country',
      '            operator: equals',
      '            value: SG',
      '  quality:',
      '    type: validate',
      '    input: sg_only',
      `    contract: ${FAIL_CONTRACT}`,
      '  renamed:',
      '    type: transform',
      '    inputs: [sg_only]',
      '    operation:',
      '      rename:',
      '        columns:',
      '          customer_id: customer_ref',
      '  tail:',
      '    type: transform',
      '    inputs: [renamed]',
      '    operation:',
      '      rename:',
      '        columns:',
      '          country: market',
    ].join('\n')
    const pipelinePath = out('post-gate.yaml')
    writeFileSync(pipelinePath, pipeline)
    const run = runCli([
      'dcr',
      pipelinePath,
      '--out',
      out('x6.yaml'),
      '--base-node',
      'renamed',
      '--base-dataset-id',
      'b',
      '--candidate-node',
      'tail',
      '--candidate-dataset-id',
      'c',
    ])
    expect(run.exitCode).toBe(2)
    expect(run.stderr).toContain('did not execute in this run')
  })

  it('reports a malformed pipeline with located, sanitized errors (exit 2)', () => {
    const pipelinePath = out('malformed.yaml')
    writeFileSync(pipelinePath, 'version: 1\npipeline: broken\nnodes: [ unclosed\n')
    const run = runCli([
      'dcr',
      pipelinePath,
      '--out',
      out('x7.yaml'),
      '--base-node',
      'a',
      '--base-dataset-id',
      'b',
      '--candidate-node',
      'c',
      '--candidate-dataset-id',
      'd',
    ])
    expect(run.exitCode).toBe(2)
    expect(run.stderr).toContain('could not be parsed')
  })

  it('keeps the dcr flags dcr-only (the m6-3 cross-command discipline)', () => {
    const dataset = join(REPO_DIR, 'fixtures', 'csv', 'customers.csv')
    const run = runCli(['validate', dataset, '--contract', FAIL_CONTRACT, '--out', out('x8.yaml')])
    expect(run.exitCode).toBe(2)
    expect(run.stderr).toContain('does not take --out')
  })
})

describe('assay dcr — result-class refusals (exit 1, the report on stdout, no artifact)', () => {
  it('a failed node run is a first-class result: report on stdout, no artifact, raw engine text dropped', () => {
    const pipeline = [
      'version: 1',
      'pipeline: dcr_failed_node',
      'nodes:',
      '  a:',
      '    type: source',
      '    source:',
      '      kind: file',
      `      path: ${GOLDEN_DATASET}`,
      '  broken:',
      '    type: sql',
      '    inputs: [a]',
      '    sql: SELECT no_such_column FROM a',
    ].join('\n')
    const pipelinePath = out('failed-node.yaml')
    writeFileSync(pipelinePath, pipeline)
    const outPath = out('x-failed.yaml')
    const run = runCli([
      'dcr',
      pipelinePath,
      '--out',
      outPath,
      '--base-node',
      'a',
      '--base-dataset-id',
      'b',
      '--candidate-node',
      'broken',
      '--candidate-dataset-id',
      'c',
    ])
    expect(run.exitCode).toBe(1)
    expect(run.stdout).toContain('FAILED')
    expect(run.stdout).toContain('could not be materialized')
    // The raw engine error text is dropped at the seam (ADR 0025) — no SQL,
    // no DuckDB wording, and definitely no artifact.
    expect(existsSync(outPath)).toBe(false)
  })

  it('an export-mode plan is a typed mode refusal (exit 1, nothing executed)', () => {
    const pipeline = [
      'version: 1',
      'pipeline: dcr_export_mode',
      'nodes:',
      '  a:',
      '    type: source',
      '    source:',
      '      kind: file',
      `      path: ${GOLDEN_DATASET}`,
      '  out:',
      '    type: transform',
      '    inputs: [a]',
      '    materialization: export',
      '    operation:',
      '      rename:',
      '        columns:',
      '          customer_id: customer_ref',
    ].join('\n')
    const pipelinePath = out('export-mode.yaml')
    writeFileSync(pipelinePath, pipeline)
    const outPath = out('x-export.yaml')
    const run = runCli([
      'dcr',
      pipelinePath,
      '--out',
      outPath,
      '--base-node',
      'a',
      '--base-dataset-id',
      'b',
      '--candidate-node',
      'out',
      '--candidate-dataset-id',
      'c',
    ])
    expect(run.exitCode).toBe(1)
    expect(run.stdout).toContain('REFUSED')
    expect(existsSync(outPath)).toBe(false)
  })
})

describe('assay help — the dcr surface is documented', () => {
  it('lists the dcr command and its flags', () => {
    const run = runCli(['--help'])
    expect(run.exitCode).toBe(0)
    expect(run.stdout).toContain('  assay dcr <file> [options]')
    expect(run.stdout).toContain('dcr options:')
    expect(run.stdout).toContain('--base-dataset-id <id>')
    expect(run.stdout).toContain('never overwritten')
  })
})
