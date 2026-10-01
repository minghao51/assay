// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * p2-5 item 2: `assay pipeline run` must refuse an unbound gate (a missing
 * contract, or a diff node with no explicit key set) at exit 2 BEFORE it loads
 * the native engine seam (`@assay/engine-duckdb/node`) or opens a connection.
 * This is the C2 "refuse before any execution" boundary, and the pin is
 * structural (module mocks that record their own invocation), so moving the
 * refusal behind the engine boot fails the test.
 *
 * The engine seam is mocked in a SEPARATE file from `pipeline-lazy-engine`
 * (each `vi.mock` is file-scoped): that file pins that `validate` never loads
 * the seam, while this one pins that a `run` gate refusal never loads it
 * either. The `./connection.js` mock proves the connection is never opened.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const engine = vi.hoisted(() => ({ imports: 0, connections: 0, executions: 0 }))

vi.mock('@assay/engine-duckdb/node', () => {
  engine.imports += 1
  return {
    PipelineRunError: class PipelineRunError extends Error {},
    PipelineRunRefusalError: class PipelineRunRefusalError extends Error {},
    detectFileFormat: () => 'csv',
    executePipeline: async () => {
      engine.executions += 1
      throw new Error('the native engine must not be reached before the gate refusal')
    },
  }
})

vi.mock('./connection.js', () => ({
  openConnection: async () => {
    engine.connections += 1
    throw new Error('the connection must not be opened before the gate refusal')
  },
}))

import { CliError } from './errors.js'
import { runPipelineCommand } from './pipeline.js'
import { silentProgress } from './progress.js'
import { plainStyle } from './style.js'
import type { CommandContext } from './context.js'

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

describe('pipeline run refuses an unbound gate before any engine call (p2-5 item 2)', () => {
  it('a missing validate contract exits 2 with no seam import, no connection, no execution', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'assay-p2-5-gate-refusal-'))
    const path = join(dir, 'unbound.yaml')
    writeFileSync(
      path,
      `version: 1
pipeline: unbound_gate
nodes:
  a:
    type: source
    source:
      kind: file
      path: ./missing.csv
  gate:
    type: validate
    input: a
    contract: contracts/missing.yaml
`,
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
    // The C2 boundary: the refusal is a pre-execution input failure.
    expect(context.output()).toBe('')
    expect(engine.imports).toBe(0)
    expect(engine.connections).toBe(0)
    expect(engine.executions).toBe(0)
  })

  it('a diff node without an explicit key set also exits 2 before any engine call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'assay-p2-5-gate-refusal-'))
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
      path: ./missing.csv
  b:
    type: source
    source:
      kind: file
      path: ./missing.csv
  compare:
    type: diff
    input: a
    against: b
`,
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
      'compare: a diff node requires an explicit key set',
    )
    expect(engine.imports).toBe(0)
    expect(engine.connections).toBe(0)
    expect(engine.executions).toBe(0)
  })
})
