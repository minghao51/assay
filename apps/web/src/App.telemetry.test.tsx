// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EngineTableHandle } from '@assay/engine-duckdb'
import { App } from './App'
import type { WebTelemetryRuntime } from './telemetry/runtime'

/**
 * App-level telemetry wiring pins, driven through the real composition root
 * with only the picker/engine boundaries faked and an injected fake runtime:
 * `app_boot` on mount, the first-run disclosure render/flip, the Settings
 * toggle, and `dataset_opened`/`dataset_open_failed` from the open flow.
 */

interface PickResult {
  readonly source: { readonly getFile: () => Promise<File> }
}

const h = vi.hoisted(() => ({
  pickers: [] as Array<(value: PickResult | null) => void>,
  failOpen: false,
}))

const FAKE_HANDLE: EngineTableHandle = { kind: 'table', id: 't1' }
const FAKE_SCHEMA: readonly { name: string; type: string }[] = [{ name: 'id', type: 'BIGINT' }]

vi.mock('@assay/data-sources/browser', () => ({
  pickDataFile: (): Promise<PickResult | null> =>
    new Promise((resolve) => {
      h.pickers.push(resolve)
    }),
}))

vi.mock('./lib/engine', () => ({
  engineClient: {
    open: async () => {
      if (h.failOpen) throw new Error('/home/secret/patient.parquet')
      return FAKE_HANDLE
    },
    schema: async () => FAKE_SCHEMA,
    rowCount: async () => 1,
    fetchRange: async () => ({
      batch: { numRows: 0, numCols: 0, getChildAt: () => null },
      hasMore: false,
    }),
    dispose: async () => undefined,
  },
}))

vi.mock('./sql/SqlPanel', () => ({ SqlPanel: () => null }))
vi.mock('./profile/ProfilePanel', () => ({ ProfilePanel: () => null }))

function fakeRuntime(overrides: Partial<WebTelemetryRuntime> = {}): WebTelemetryRuntime {
  let pending = true
  return {
    surface: 'web',
    hardOff: false,
    endpointConfigured: true,
    emit: vi.fn(),
    flush: vi.fn(async () => undefined),
    getPreference: () => 'on',
    setPreference: vi.fn(),
    isEnabledNow: () => true,
    shouldShowDisclosure: () => pending,
    markDisclosureShown: vi.fn(() => {
      pending = false
    }),
    dispose: vi.fn(),
    ...overrides,
  }
}

function source(name = 'patients.parquet'): PickResult {
  return { source: { getFile: async () => new File(['x'], name) } }
}

afterEach(() => {
  cleanup()
  h.pickers = []
  h.failOpen = false
})

describe('App telemetry wiring', () => {
  it('emits app_boot once on mount with the coarse os family', () => {
    const runtime = fakeRuntime()
    render(<App telemetry={runtime} />)
    expect(runtime.emit).toHaveBeenCalledWith(
      'app_boot',
      expect.objectContaining({ engine_family: 'duckdb_wasm' }),
    )
  })

  it('renders the disclosure and flips the preference from "Turn it off"', () => {
    const runtime = fakeRuntime()
    render(<App telemetry={runtime} />)
    expect(screen.getByTestId('telemetry-disclosure')).toBeTruthy()
    fireEvent.click(screen.getByTestId('telemetry-turn-off'))
    expect(runtime.setPreference).toHaveBeenCalledWith('off')
    expect(screen.queryByTestId('telemetry-disclosure')).toBeNull()
  })

  it('opens Settings and toggles the anonymous usage preference', () => {
    const runtime = fakeRuntime()
    render(<App telemetry={runtime} />)
    // Dismiss the disclosure first (it is modal-ish in the header flow).
    fireEvent.click(screen.getByTestId('telemetry-keep-on'))
    fireEvent.click(screen.getByTestId('settings-toggle'))
    fireEvent.click(screen.getByTestId('telemetry-toggle'))
    expect(runtime.setPreference).toHaveBeenCalledWith('off')
  })

  it('emits dataset_opened with role/format/size/row/column buckets on success', async () => {
    const runtime = fakeRuntime()
    render(<App telemetry={runtime} />)
    // Dismiss the first-run disclosure first: it is an owned modal, so Open is
    // correctly disabled behind it (K17) and the open flow below needs the idle
    // frame (the same setup the Settings test above uses).
    fireEvent.click(screen.getByTestId('telemetry-keep-on'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('open-button'))
    })
    await act(async () => {
      h.pickers[0]?.(source())
    })
    await screen.findByTestId('schema-section')
    expect(runtime.emit).toHaveBeenCalledWith(
      'dataset_opened',
      expect.objectContaining({
        dataset_role: 'primary',
        format_kind: 'parquet',
        size_bucket: 'lt_1mb',
        row_count_bucket: '1_1k',
        column_count_bucket: '1_10',
      }),
    )
  })

  it('emits dataset_open_failed with a closed reason code and no path', async () => {
    h.failOpen = true
    const runtime = fakeRuntime()
    render(<App telemetry={runtime} />)
    // Dismiss the first-run disclosure first (see the test above): K17 disables
    // Open while that modal owns the frame in the idle phase too.
    fireEvent.click(screen.getByTestId('telemetry-keep-on'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('open-button'))
    })
    await act(async () => {
      h.pickers[0]?.(source())
    })
    const call = (runtime.emit as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
      (entry) => entry[0] === 'dataset_open_failed',
    )
    expect(call).toBeTruthy()
    const payload = call?.[1] as Record<string, unknown>
    expect(payload['reason_code']).toBe('unknown')
    expect(JSON.stringify(payload)).not.toContain('patient')
    expect(JSON.stringify(payload)).not.toContain('/home')
  })
})
