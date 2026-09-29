// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from 'vitest'
import type { TelemetryEvent } from '@assay/telemetry'
import { readDisclosureShown, readPreference } from './prefs'
import type { StorageLike } from './prefs'
import { clampClientDay, createWebTelemetry } from './runtime'
import type { TelemetryTransport } from './transport'
import type { WebTelemetryBuildConfig } from './config'

function fakeStorage(initial: Record<string, string> = {}): StorageLike & {
  readonly map: Record<string, string>
} {
  const map = { ...initial }
  return {
    map,
    getItem: (key) => map[key] ?? null,
    setItem: (key, value) => {
      map[key] = value
    },
  }
}

function config(overrides: Partial<WebTelemetryBuildConfig> = {}): WebTelemetryBuildConfig {
  return {
    endpoint: 'https://collector.example/ingest',
    token: '',
    hardOff: false,
    appVersion: { major: 1, minor: 2, patch: 3 },
    buildChannel: 'dev',
    ...overrides,
  }
}

interface CapturedTransport extends TelemetryTransport {
  readonly batches: TelemetryEvent[][]
  readonly calls: number
}

function capturingTransport(
  behavior: (batch: readonly TelemetryEvent[]) => Promise<void> = async () => undefined,
): CapturedTransport {
  const batches: TelemetryEvent[][] = []
  let calls = 0
  return {
    batches,
    get calls() {
      return calls
    },
    async send(batch) {
      calls += 1
      batches.push([...batch])
      await behavior(batch)
    },
  }
}

/** Let the fire-and-forget emit tail settle, then flush explicitly. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('createWebTelemetry — inert by default (R6) and hard off', () => {
  it('is inert with no endpoint: no disclosure, no buffer, no send', async () => {
    const transport = capturingTransport()
    const runtime = createWebTelemetry({
      config: config({ endpoint: '' }),
      storage: fakeStorage(),
      transport,
    })
    expect(runtime.endpointConfigured).toBe(false)
    expect(runtime.isEnabledNow()).toBe(false)
    expect(runtime.shouldShowDisclosure()).toBe(false)
    runtime.emit('app_boot', {
      engine_family: 'duckdb_wasm',
      os_family: 'linux',
      build_channel: 'dev',
    })
    await runtime.flush()
    expect(transport.calls).toBe(0)
  })

  it('is hard off when ASSAY_NO_TELEMETRY was set at build time', () => {
    const runtime = createWebTelemetry({
      config: config({ hardOff: true }),
      storage: fakeStorage(),
      transport: capturingTransport(),
    })
    expect(runtime.hardOff).toBe(true)
    expect(runtime.isEnabledNow()).toBe(false)
    expect(runtime.shouldShowDisclosure()).toBe(false)
  })

  it('treats a non-loopback cleartext endpoint as unconfigured (design §8.2)', () => {
    const runtime = createWebTelemetry({
      config: config({ endpoint: 'http://evil.example' }),
      storage: fakeStorage(),
    })
    expect(runtime.endpointConfigured).toBe(false)
    expect(runtime.isEnabledNow()).toBe(false)
  })
})

describe('createWebTelemetry — emission, disclosure gate, batching', () => {
  it('never schedules a flush before the first-run disclosure is marked shown', async () => {
    const tasks: Array<() => void> = []
    const transport = capturingTransport()
    const runtime = createWebTelemetry({
      config: config(),
      storage: fakeStorage(),
      transport,
      scheduleFlush: (task) => {
        tasks.push(task)
        return tasks.length
      },
      cancelFlush: () => undefined,
    })
    runtime.emit('app_boot', {
      engine_family: 'duckdb_wasm',
      os_family: 'linux',
      build_channel: 'dev',
    })
    await settle()
    // Disclosure pending ⇒ no flush scheduled, nothing on the wire.
    expect(tasks).toHaveLength(0)
    expect(transport.calls).toBe(0)

    runtime.markDisclosureShown()
    expect(tasks).toHaveLength(1)
    await runtime.flush()
    expect(transport.calls).toBe(1)
    expect(transport.batches[0]?.map((event) => event.event)).toContain('app_boot')
  })

  it('never sends on a direct flush() before the disclosure is marked shown (§6.3)', async () => {
    const transport = capturingTransport()
    const runtime = createWebTelemetry({
      config: config(),
      storage: fakeStorage(),
      transport,
      scheduleFlush: () => 1,
      cancelFlush: () => undefined,
    })
    runtime.emit('app_boot', {
      engine_family: 'duckdb_wasm',
      os_family: 'linux',
      build_channel: 'dev',
    })
    await settle()
    // The pagehide path calls flush() directly; it must not beat the
    // disclosure gate.
    await runtime.flush()
    expect(transport.calls).toBe(0)

    // Once shown, the same buffered event flushes normally.
    runtime.markDisclosureShown()
    await runtime.flush()
    expect(transport.calls).toBe(1)
    expect(transport.batches[0]?.map((event) => event.event)).toContain('app_boot')
  })

  it('emits a validated envelope with the build version + clamped client day', async () => {
    const transport = capturingTransport()
    const runtime = createWebTelemetry({
      config: config(),
      storage: fakeStorage({ 'assay.telemetry.disclosure': '1' }),
      transport,
      now: () => 0, // before the 1970 clamp floor
    })
    runtime.emit('app_boot', {
      engine_family: 'duckdb_wasm',
      os_family: 'linux',
      build_channel: 'dev',
    })
    await settle()
    await runtime.flush()
    const event = transport.batches[0]?.[0]
    expect(event?.client_day).toBe(19000)
    expect(event?.app_version_major).toBe(1)
    expect(event?.app_version_patch).toBe(3)
    expect(event?.surface).toBe('web')
  })

  it('caps dataset_opened at 50 per session (t-1 carry-over, design §5.2)', async () => {
    const transport = capturingTransport()
    const runtime = createWebTelemetry({
      config: config(),
      storage: fakeStorage({ 'assay.telemetry.disclosure': '1' }),
      transport,
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
      if (index % 10 === 9) {
        await settle()
        await runtime.flush()
      }
    }
    await settle()
    await runtime.flush()
    const sent = transport.batches.flat().filter((event) => event.event === 'dataset_opened')
    expect(sent).toHaveLength(50)
  })

  it('always sends the first query of the session (bypasses the 10% rate)', async () => {
    const transport = capturingTransport()
    const runtime = createWebTelemetry({
      config: config(),
      storage: fakeStorage({ 'assay.telemetry.disclosure': '1' }),
      transport,
    })
    runtime.emit('query_run', {
      query_kind: 'user_sql',
      row_count_bucket: '1_1k',
      duration_bucket: 'lt_50ms',
      outcome: 'success',
    })
    await settle()
    await runtime.flush()
    expect(transport.batches.flat().map((event) => event.event)).toContain('query_run')
  })

  it('sends error outcomes even though query_run is sampled (bypass)', async () => {
    const transport = capturingTransport()
    const runtime = createWebTelemetry({
      config: config(),
      storage: fakeStorage({ 'assay.telemetry.disclosure': '1' }),
      transport,
    })
    runtime.emit(
      'query_run',
      {
        query_kind: 'filter',
        row_count_bucket: 'zero',
        duration_bucket: 'lt_50ms',
        outcome: 'error',
      },
      'error',
    )
    await settle()
    await runtime.flush()
    expect(transport.batches.flat().map((event) => event.event)).toContain('query_run')
  })
})

describe('createWebTelemetry — opt-out semantics (design §6.4/§6.5)', () => {
  it('re-reads the preference on every send and clears the buffer on opt-out', async () => {
    const storage = fakeStorage({ 'assay.telemetry.disclosure': '1' })
    const transport = capturingTransport()
    const runtime = createWebTelemetry({ config: config(), storage, transport })
    runtime.emit('app_boot', {
      engine_family: 'duckdb_wasm',
      os_family: 'linux',
      build_channel: 'dev',
    })
    await settle()
    // A direct storage flip (not via setPreference) must still be honored.
    storage.setItem('assay.telemetry', 'off')
    await runtime.flush()
    expect(transport.calls).toBe(0)
  })

  it('setPreference persists and clears the buffer synchronously', () => {
    const storage = fakeStorage({ 'assay.telemetry.disclosure': '1' })
    const runtime = createWebTelemetry({
      config: config(),
      storage,
      transport: capturingTransport(),
    })
    runtime.setPreference('off')
    expect(readPreference(storage)).toBe('off')
    expect(runtime.isEnabledNow()).toBe(false)
    expect(runtime.getPreference()).toBe('off')
  })

  it('clears the buffer synchronously on opt-out (drop, never flush, §6.5)', async () => {
    const storage = fakeStorage({ 'assay.telemetry.disclosure': '1' })
    const transport = capturingTransport()
    const runtime = createWebTelemetry({ config: config(), storage, transport })
    runtime.emit('app_boot', {
      engine_family: 'duckdb_wasm',
      os_family: 'linux',
      build_channel: 'dev',
    })
    await settle()
    runtime.setPreference('off')
    expect(runtime.isEnabledNow()).toBe(false)
    expect(runtime.getPreference()).toBe('off')
    // Re-enable BEFORE flushing: if `setPreference('off')` had not cleared
    // the buffer synchronously, the surviving event would now be sent.
    runtime.setPreference('on')
    await runtime.flush()
    expect(transport.calls).toBe(0)
  })

  it('keeps a mid-session opt-out effective when storage writes throw (§6.5)', async () => {
    const storage: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota exceeded')
      },
    }
    const transport = capturingTransport()
    const runtime = createWebTelemetry({ config: config(), storage, transport })
    runtime.markDisclosureShown()
    runtime.emit('app_boot', {
      engine_family: 'duckdb_wasm',
      os_family: 'linux',
      build_channel: 'dev',
    })
    await settle()
    runtime.setPreference('off')
    expect(runtime.isEnabledNow()).toBe(false)
    expect(runtime.getPreference()).toBe('off')
    runtime.setPreference('on')
    await runtime.flush()
    expect(transport.calls).toBe(0)
  })

  it('marks the disclosure shown in storage', () => {
    const storage = fakeStorage()
    const runtime = createWebTelemetry({
      config: config(),
      storage,
      transport: capturingTransport(),
    })
    expect(runtime.shouldShowDisclosure()).toBe(true)
    runtime.markDisclosureShown()
    expect(readDisclosureShown(storage)).toBe(true)
    expect(runtime.shouldShowDisclosure()).toBe(false)
  })
})

describe('createWebTelemetry — failure silence (R9)', () => {
  it('swallows a rejecting transport and still resolves flush', async () => {
    const transport = capturingTransport(async () => {
      throw new Error('network down')
    })
    const runtime = createWebTelemetry({
      config: config(),
      storage: fakeStorage({ 'assay.telemetry.disclosure': '1' }),
      transport,
    })
    runtime.emit('app_boot', {
      engine_family: 'duckdb_wasm',
      os_family: 'linux',
      build_channel: 'dev',
    })
    await settle()
    await expect(runtime.flush()).resolves.toBeUndefined()
  })

  it('disposes the pending flush timer', async () => {
    const cancel = vi.fn()
    const runtime = createWebTelemetry({
      config: config(),
      storage: fakeStorage({ 'assay.telemetry.disclosure': '1' }),
      transport: capturingTransport(),
      scheduleFlush: () => 7,
      cancelFlush: cancel,
    })
    runtime.emit('app_boot', {
      engine_family: 'duckdb_wasm',
      os_family: 'linux',
      build_channel: 'dev',
    })
    await settle()
    runtime.dispose()
    expect(cancel).toHaveBeenCalledWith(7)
  })
})

describe('clampClientDay', () => {
  it('clamps into the schema bound', () => {
    expect(clampClientDay(-1)).toBe(19000)
    expect(clampClientDay(Number.MAX_SAFE_INTEGER)).toBe(40000)
    expect(clampClientDay(86_400_000 * 20_000)).toBe(20000)
  })
})
