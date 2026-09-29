// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * CLI command-boundary emission pins (design §2/Appendix C, reviewer round 1).
 *
 * These drive the real `runValidateCommand` / `runDiffCommand` (real DuckDB,
 * runtime-built temp files) with a `CommandContext`-level fake telemetry sink,
 * so the event wiring is asserted directly:
 *
 * - registration failure → `dataset_open_failed` only (no `dataset_opened`,
 *   no run event — the run never started);
 * - registration success then a binding/plan/engine failure → `dataset_opened`
 *   followed by `validation_run`/`diff_run` with `outcome: 'error'`;
 * - `outcome: 'aborted'` is unreachable from the CLI (no abort UX) and is
 *   never invented.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { EventName, TelemetryOutcome, TelemetryPayload } from '@assay/telemetry'
import type { CommandContext } from './context.js'
import { runDiffCommand } from './diff.js'
import type { DiffOptions } from './diff.js'
import { silentProgress } from './progress.js'
import { plainStyle } from './style.js'
import type { CliTelemetry } from './telemetry/runtime.js'
import { BINDING_ERROR_CONTRACT, SMALL_DIRTY_CONTRACT, SMALL_DIRTY_CSV } from './test-datasets.js'
import { runValidateCommand } from './validate.js'
import type { ValidateOptions } from './validate.js'

interface Emitted {
  readonly event: EventName
  readonly payload: TelemetryPayload[EventName]
  readonly outcome?: TelemetryOutcome
}

/** A capturing `CliTelemetry` sink (no network, no timers). */
function fakeTelemetry(emitted: Emitted[]): CliTelemetry {
  return {
    active: true,
    start: () => undefined,
    emit: ((event: EventName, payload: TelemetryPayload[EventName], outcome?: TelemetryOutcome) => {
      emitted.push(outcome === undefined ? { event, payload } : { event, payload, outcome })
    }) as CliTelemetry['emit'],
    flush: async () => undefined,
    reasonFromError: () => 'unknown',
  }
}

function context(emitted: Emitted[]): CommandContext {
  return {
    out: () => undefined,
    style: plainStyle,
    progress: silentProgress,
    telemetry: fakeTelemetry(emitted),
  }
}

const tempDirs: string[] = []
function tempFile(name: string, text: string): string {
  if (tempDirs.length === 0) {
    tempDirs.push(mkdtempSync(join(tmpdir(), 'assay-t2-emit-')))
  }
  const path = join(tempDirs[0] as string, name)
  writeFileSync(path, text)
  return path
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function validateOptions(datasetPath: string, contractPath: string): ValidateOptions {
  return { datasetPath, contractPath, format: 'human', sampleLimit: 20 }
}

function diffOptions(pathA: string, pathB: string, keys: readonly string[]): DiffOptions {
  return { pathA, pathB, keys, infer: false, format: 'human', sampleLimit: 20 }
}

function events(emitted: readonly Emitted[]): EventName[] {
  return emitted.map((entry) => entry.event)
}

describe('CLI validate — command-boundary emission (design §2)', () => {
  it('emits dataset_open_failed (and no run event) when registration fails', async () => {
    const emitted: Emitted[] = []
    const contract = tempFile('contract.yaml', SMALL_DIRTY_CONTRACT)
    await expect(
      runValidateCommand(validateOptions('/nonexistent/nope.parquet', contract), context(emitted)),
    ).rejects.toThrow()
    expect(events(emitted)).toEqual(['dataset_open_failed'])
    expect(emitted[0]?.payload).toMatchObject({
      dataset_role: 'primary',
      format_kind: 'unknown',
    })
  })

  it('emits dataset_opened then validation_run outcome=error on a binding failure', async () => {
    const emitted: Emitted[] = []
    const dataset = tempFile('dirty.csv', SMALL_DIRTY_CSV)
    const contract = tempFile('binding.yaml', BINDING_ERROR_CONTRACT)
    await expect(
      runValidateCommand(validateOptions(dataset, contract), context(emitted)),
    ).rejects.toThrow()
    expect(events(emitted)).toEqual(['dataset_opened', 'validation_run'])
    expect(emitted[1]?.payload).toMatchObject({
      outcome: 'error',
      checks_run: 0,
      finding_count_bucket: 'zero',
    })
    // Error outcomes bypass sampling at the seam.
    expect(emitted[1]?.outcome).toBe('error')
  })
})

describe('CLI diff — command-boundary emission (design §2)', () => {
  it('emits dataset_opened(side_a) + dataset_open_failed(side_b), no diff_run', async () => {
    const emitted: Emitted[] = []
    const pathA = tempFile('a.csv', SMALL_DIRTY_CSV)
    await expect(
      runDiffCommand(diffOptions(pathA, '/nonexistent/nope.csv', ['id']), context(emitted)),
    ).rejects.toThrow()
    expect(events(emitted)).toEqual(['dataset_opened', 'dataset_open_failed'])
    expect(emitted[0]?.payload).toMatchObject({ dataset_role: 'side_a' })
    expect(emitted[1]?.payload).toMatchObject({ dataset_role: 'side_b' })
  })

  it('emits dataset_opened ×2 then diff_run outcome=error when the plan does not bind', async () => {
    const emitted: Emitted[] = []
    const pathA = tempFile('a.csv', SMALL_DIRTY_CSV)
    const pathB = tempFile('b.csv', SMALL_DIRTY_CSV)
    await expect(
      runDiffCommand(diffOptions(pathA, pathB, ['ghost_col']), context(emitted)),
    ).rejects.toThrow()
    expect(events(emitted)).toEqual(['dataset_opened', 'dataset_opened', 'diff_run'])
    expect(emitted[2]?.payload).toMatchObject({
      outcome: 'error',
      aspects_count: 0,
      key_mode: 'none',
    })
    expect(emitted[2]?.outcome).toBe('error')
  })
})
