// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * p2-1 (c): `assay pipeline validate` must NEVER load the native engine seam
 * (`@assay/engine-duckdb/node`, which pulls `@duckdb/node-api`).
 *
 * The proof is structural, not timing-based: the module mock below records any
 * import of the seam. `./pipeline.js` is imported statically by this test, so a
 * re-introduced static import anywhere on the validate path would trip the
 * flag during module evaluation — before the test body even runs. The run path
 * (which legitimately needs the native engine) is proven separately by
 * `pipeline.test.ts`'s real-engine "run" test.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({ loaded: false }))

vi.mock('@assay/engine-duckdb/node', () => {
  native.loaded = true
  return {
    PipelineRunError: class PipelineRunError extends Error {},
    PipelineRunRefusalError: class PipelineRunRefusalError extends Error {},
    detectFileFormat: () => null,
    executePipeline: async () => {
      throw new Error('the native engine must not be reached on the validate path')
    },
  }
})

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

describe('pipeline validate never loads the native engine (p2-1 (c))', () => {
  it('the engine seam is not imported before or during validate', async () => {
    // Guards against a static import: the mock factory would already have run.
    expect(native.loaded).toBe(false)

    const dir = mkdtempSync(join(tmpdir(), 'assay-p2-1-lazy-'))
    const path = join(dir, 'valid.yaml')
    // The source names a dataset that does not exist — validate never
    // resolves or opens it, so this must still succeed without the engine.
    writeFileSync(
      path,
      'version: 1\npipeline: lazy\nnodes:\n  a:\n    type: source\n    source:\n      kind: file\n      path: ./missing.csv\n',
    )

    const context = captureContext()
    const code = await runPipelineCommand(
      { subcommand: 'validate', pipelinePath: path, format: 'json', keys: [] },
      context,
    )
    expect(code).toBe(0)
    const payload = JSON.parse(context.output()) as { report: string; valid: boolean }
    expect(payload.report).toBe('assay-pipeline-validate-report')
    expect(payload.valid).toBe(true)
    expect(native.loaded).toBe(false)
  })
})
