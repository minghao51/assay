// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TelemetryEvent } from '@assay/telemetry'
import { CLI_DISCLOSURE_COPY } from '@assay/telemetry'
import { readConfig, writeConfig } from './config'
import type { CliTelemetryTransport } from './transport'
import { createCliTelemetry } from './runtime'

const tempDirs: string[] = []
function tempEnv(extra: Record<string, string> = {}): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'assay-t2-rt-'))
  tempDirs.push(dir)
  return { ASSAY_CONFIG_DIR: dir, ...extra }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface Capture extends CliTelemetryTransport {
  readonly batches: TelemetryEvent[][]
  readonly chunks: string[]
}

function transport(behavior: () => Promise<void> = async () => undefined): Capture {
  const batches: TelemetryEvent[][] = []
  return {
    batches,
    chunks: [],
    async send(batch) {
      batches.push([...batch])
      await behavior()
    },
  }
}

function sink(): { chunks: string[]; write(chunk: string): unknown } {
  const chunks: string[] = []
  return {
    chunks,
    write(chunk) {
      chunks.push(chunk)
      return true
    },
  }
}

describe('createCliTelemetry — inert, disclosure, precedence', () => {
  it('is inert without an endpoint (R6)', async () => {
    const env = tempEnv()
    const capture = transport()
    const stderr = sink()
    const runtime = createCliTelemetry({ env, flagNoTelemetry: false, stderr, transport: capture })
    expect(runtime.active).toBe(false)
    runtime.start()
    runtime.emit('app_boot', {
      engine_family: 'duckdb_node',
      os_family: 'linux',
      build_channel: 'release',
    })
    await runtime.flush()
    expect(stderr.chunks).toEqual([])
    expect(capture.batches).toEqual([])
  })

  it('shows the disclosure to stderr once and emits app_boot + disclosure_shown', async () => {
    const env = tempEnv({ ASSAY_TELEMETRY_ENDPOINT: 'https://collector.example' })
    const capture = transport()
    const stderr = sink()
    const runtime = createCliTelemetry({ env, flagNoTelemetry: false, stderr, transport: capture })
    expect(runtime.active).toBe(true)
    runtime.start()
    await runtime.flush()
    expect(stderr.chunks.join('')).toBe(`${CLI_DISCLOSURE_COPY}\n`)
    const events = capture.batches.flat().map((event) => event.event)
    expect(events).toContain('app_boot')
    expect(events).toContain('disclosure_shown')

    // A second run against the same config dir must not show it again.
    const capture2 = transport()
    const stderr2 = sink()
    const runtime2 = createCliTelemetry({
      env,
      flagNoTelemetry: false,
      stderr: stderr2,
      transport: capture2,
    })
    runtime2.start()
    await runtime2.flush()
    expect(stderr2.chunks).toEqual([])
    expect(capture2.batches.flat().map((event) => event.event)).not.toContain('disclosure_shown')
  })

  it('honors ASSAY_NO_TELEMETRY (any non-empty) as a hard off', async () => {
    const env = tempEnv({
      ASSAY_TELEMETRY_ENDPOINT: 'https://collector.example',
      ASSAY_NO_TELEMETRY: '0',
    })
    const capture = transport()
    const stderr = sink()
    const runtime = createCliTelemetry({ env, flagNoTelemetry: false, stderr, transport: capture })
    expect(runtime.active).toBe(false)
    runtime.start()
    await runtime.flush()
    expect(stderr.chunks).toEqual([])
    expect(capture.batches).toEqual([])
  })

  it('honors --no-telemetry for the invocation and suppresses the disclosure', async () => {
    const env = tempEnv({ ASSAY_TELEMETRY_ENDPOINT: 'https://collector.example' })
    const capture = transport()
    const stderr = sink()
    const runtime = createCliTelemetry({ env, flagNoTelemetry: true, stderr, transport: capture })
    runtime.start()
    await runtime.flush()
    expect(stderr.chunks).toEqual([])
    expect(capture.batches).toEqual([])
  })

  it('honors a persisted config preference of off', async () => {
    const env = tempEnv({ ASSAY_TELEMETRY_ENDPOINT: 'https://collector.example' })
    writeConfig(env, { preference: 'off' })
    const capture = transport()
    const stderr = sink()
    const runtime = createCliTelemetry({ env, flagNoTelemetry: false, stderr, transport: capture })
    runtime.start()
    await runtime.flush()
    expect(stderr.chunks).toEqual([])
    expect(capture.batches).toEqual([])
  })

  it('lets ASSAY_NO_TELEMETRY beat the config/flag (precedence)', async () => {
    const env = tempEnv({
      ASSAY_TELEMETRY_ENDPOINT: 'https://collector.example',
      ASSAY_NO_TELEMETRY: '1',
    })
    const capture = transport()
    const runtime = createCliTelemetry({
      env,
      flagNoTelemetry: true,
      stderr: sink(),
      transport: capture,
    })
    expect(runtime.active).toBe(false)
    await runtime.flush()
    expect(capture.batches).toEqual([])
  })
})

describe('createCliTelemetry — emission, caps, failure silence', () => {
  it('clamps client_day and caps dataset_opened at 50 per session', async () => {
    const env = tempEnv({ ASSAY_TELEMETRY_ENDPOINT: 'https://collector.example' })
    writeConfig(env, { disclosureShown: true })
    const capture = transport()
    const runtime = createCliTelemetry({
      env,
      flagNoTelemetry: false,
      stderr: sink(),
      transport: capture,
      now: () => 0,
    })
    const payload = {
      dataset_role: 'primary' as const,
      format_kind: 'parquet' as const,
      size_bucket: 'lt_1mb' as const,
      row_count_bucket: '1_1k' as const,
      column_count_bucket: '1_10' as const,
    }
    for (let index = 0; index < 55; index++) {
      runtime.emit('dataset_opened', payload)
      if (index % 10 === 9) await runtime.flush()
    }
    await runtime.flush()
    const opened = capture.batches.flat().filter((event) => event.event === 'dataset_opened')
    expect(opened).toHaveLength(50)
    expect(opened[0]?.client_day).toBe(19000)
  })

  it('swallows a rejecting transport (R9)', async () => {
    const env = tempEnv({ ASSAY_TELEMETRY_ENDPOINT: 'https://collector.example' })
    writeConfig(env, { disclosureShown: true })
    const capture = transport(async () => {
      throw new Error('offline')
    })
    const runtime = createCliTelemetry({
      env,
      flagNoTelemetry: false,
      stderr: sink(),
      transport: capture,
    })
    runtime.emit('app_boot', {
      engine_family: 'duckdb_node',
      os_family: 'linux',
      build_channel: 'release',
    })
    await expect(runtime.flush()).resolves.toBeUndefined()
  })

  it('bounds the exit flush even when the transport hangs', async () => {
    const env = tempEnv({ ASSAY_TELEMETRY_ENDPOINT: 'https://collector.example' })
    writeConfig(env, { disclosureShown: true })
    const hanging: CliTelemetryTransport = { send: () => new Promise<void>(() => undefined) }
    const runtime = createCliTelemetry({
      env,
      flagNoTelemetry: false,
      stderr: sink(),
      transport: hanging,
    })
    runtime.emit('app_boot', {
      engine_family: 'duckdb_node',
      os_family: 'linux',
      build_channel: 'release',
    })
    await expect(runtime.flush(5)).resolves.toBeUndefined()
  })

  it('persists an install token across runs', async () => {
    const env = tempEnv({ ASSAY_TELEMETRY_ENDPOINT: 'https://collector.example' })
    writeConfig(env, { disclosureShown: true })
    const capture = transport()
    const runtime = createCliTelemetry({
      env,
      flagNoTelemetry: false,
      stderr: sink(),
      transport: capture,
    })
    runtime.emit('app_boot', {
      engine_family: 'duckdb_node',
      os_family: 'linux',
      build_channel: 'release',
    })
    await runtime.flush()
    const token = readConfig(env).installToken
    expect(token).toMatch(/^[0-9a-f]{32}$/)
  })
})
