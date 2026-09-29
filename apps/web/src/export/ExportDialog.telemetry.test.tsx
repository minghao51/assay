// SPDX-License-Identifier: AGPL-3.0-or-later

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TelemetryProvider } from '../telemetry/TelemetryContext'
import type { WebTelemetryRuntime } from '../telemetry/runtime'
import { ExportDialog } from './ExportDialog'
import type { ExportDialogProps } from './ExportDialog'

function fakeRuntime(): WebTelemetryRuntime {
  return {
    surface: 'web',
    hardOff: false,
    endpointConfigured: true,
    emit: vi.fn(),
    flush: vi.fn(async () => undefined),
    getPreference: () => 'on',
    setPreference: vi.fn(),
    isEnabledNow: () => true,
    shouldShowDisclosure: () => false,
    markDisclosureShown: vi.fn(),
    dispose: vi.fn(),
  }
}

function renderDialog(
  runtime: WebTelemetryRuntime,
  overrides: Partial<ExportDialogProps> = {},
): ExportDialogProps {
  const props: ExportDialogProps = {
    rowCount: 6,
    viewFiltered: false,
    viewSorted: false,
    runEngineExport: vi.fn(async (format) => ({
      path: `assay-exports/assay-export-1.${format}`,
      format,
      rowCount: 6,
      bytes: 1536,
    })),
    requestDestination: vi.fn(async () => ({ via: 'download' }) as const),
    writeCopy: vi.fn(async () => 'download' as const),
    onClose: vi.fn(),
    ...overrides,
  }
  render(
    <TelemetryProvider runtime={runtime}>
      <ExportDialog {...props} />
    </TelemetryProvider>,
  )
  return props
}

afterEach(cleanup)

describe('ExportDialog telemetry — export_run (design §2/Appendix C)', () => {
  it('emits success with the target format and a row bucket', async () => {
    const runtime = fakeRuntime()
    renderDialog(runtime)
    fireEvent.click(screen.getByTestId('export-confirm'))
    await waitFor(() => {
      expect(runtime.emit).toHaveBeenCalledWith('export_run', {
        target_format: 'parquet',
        row_count_bucket: '1_1k',
        outcome: 'success',
      })
    })
  })

  it('emits cancelled when the save picker is dismissed', async () => {
    const runtime = fakeRuntime()
    renderDialog(runtime, { requestDestination: vi.fn(async () => null) })
    fireEvent.click(screen.getByTestId('export-confirm'))
    await waitFor(() => {
      expect(runtime.emit).toHaveBeenCalledWith('export_run', {
        target_format: 'parquet',
        row_count_bucket: 'zero',
        outcome: 'cancelled',
      })
    })
  })

  it('emits refused for the same-source guard and error on a failure', async () => {
    const refusedRuntime = fakeRuntime()
    renderDialog(refusedRuntime, {
      requestDestination: vi.fn(async () => ({ via: 'refused-source' }) as const),
    })
    fireEvent.click(screen.getByTestId('export-confirm'))
    await waitFor(() => {
      expect(refusedRuntime.emit).toHaveBeenCalledWith('export_run', {
        target_format: 'parquet',
        row_count_bucket: 'zero',
        outcome: 'refused',
      })
    })
    cleanup()

    const errorRuntime = fakeRuntime()
    renderDialog(errorRuntime, {
      runEngineExport: vi.fn(async () => {
        throw new Error('engine down')
      }) as unknown as ExportDialogProps['runEngineExport'],
    })
    fireEvent.click(screen.getByTestId('export-confirm'))
    await waitFor(() => {
      expect(errorRuntime.emit).toHaveBeenCalledWith('export_run', {
        target_format: 'parquet',
        row_count_bucket: 'zero',
        outcome: 'error',
      })
    })
  })
})
