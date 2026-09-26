// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EngineTableHandle } from '@assay/engine-duckdb'
import { App } from './App'
import type { ArrowTableLike } from './grid/provider'

/**
 * Lifecycle + session-guard pins driven through the REAL `App` composition
 * root with only the picker/engine/contract-read boundaries faked:
 *
 * - AR-W5: the engine is disposed once on `beforeunload`/`pagehide`, and a
 *   repeated unload event does not double-fire or throw.
 * - AR-W9: a contract read that resolves after a re-open is discarded (the
 *   house session-token guard), so it cannot attach a stale contract.
 * - AR-W13: a late-resolving `openDataFile` picker cannot clobber a newer
 *   open's ready phase.
 */

interface PickResult {
  readonly source: { readonly getFile: () => Promise<File> }
}

const h = vi.hoisted(() => ({
  disposeCalls: 0,
  pickers: [] as Array<(value: PickResult | null) => void>,
  contractReads: [] as Array<(value: { readonly kind: string }) => void>,
}))

const FAKE_HANDLE: EngineTableHandle = { kind: 'table', id: 't1' }
const FAKE_SCHEMA: readonly { name: string; type: string }[] = [
  { name: 'id', type: 'BIGINT' },
  { name: 'country', type: 'VARCHAR' },
]

function fakeBatch(): ArrowTableLike {
  const columns = [{ get: () => 1 }, { get: () => 'SG' }]
  return {
    numRows: 1,
    numCols: columns.length,
    getChildAt: (index: number) => columns[index] ?? null,
  }
}

function source(): PickResult {
  return { source: { getFile: async () => new File(['id\n1\n'], 'lifecycle.jsonl') } }
}

vi.mock('@assay/data-sources/browser', () => ({
  pickDataFile: (): Promise<PickResult | null> =>
    new Promise((resolve) => {
      h.pickers.push(resolve)
    }),
}))

vi.mock('./lib/engine', () => ({
  engineClient: {
    open: async () => FAKE_HANDLE,
    schema: async () => FAKE_SCHEMA,
    rowCount: async () => 1,
    fetchRange: async () => ({ batch: fakeBatch(), hasMore: false }),
    dispose: async () => {
      h.disposeCalls += 1
    },
  },
}))

vi.mock('./validation/contract-import', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./validation/contract-import')>()
  return {
    ...actual,
    readContractFile: (): Promise<{ readonly kind: string }> =>
      new Promise((resolve) => {
        h.contractReads.push(resolve)
      }),
  }
})

vi.mock('./sql/SqlPanel', () => ({ SqlPanel: () => null }))
vi.mock('./profile/ProfilePanel', () => ({ ProfilePanel: () => null }))

afterEach(() => {
  cleanup()
  h.disposeCalls = 0
  h.pickers = []
  h.contractReads = []
})

describe('AR-W5 — engine disposal on unload', () => {
  it('disposes once on beforeunload/pagehide and never double-fires', async () => {
    const { unmount } = render(<App />)
    expect(h.disposeCalls).toBe(0)

    await act(async () => {
      window.dispatchEvent(new Event('beforeunload'))
    })
    expect(h.disposeCalls).toBe(1)

    // A second unload event (pagehide follows beforeunload in browsers) must
    // not request a second disposal.
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'))
    })
    expect(h.disposeCalls).toBe(1)

    unmount()
    expect(h.disposeCalls).toBe(1)
  })
})

describe('AR-W9 — contract import session guard', () => {
  it('discards a contract read that resolves after a re-open', async () => {
    render(<App />)

    // Open dataset A.
    await act(async () => {
      fireEvent.click(screen.getByTestId('open-button'))
    })
    await act(async () => {
      h.pickers[0]?.(source())
    })
    await screen.findByTestId('schema-section')

    // Start a contract read that we can resolve later.
    const input = screen.getByTestId('validation-contract-input') as HTMLInputElement
    Object.defineProperty(input, 'files', {
      value: [new File(['format: v1\nname: c\nversion: 1\n'], 'contract.yaml')],
      configurable: true,
    })
    await act(async () => {
      fireEvent.change(input)
    })
    expect(h.contractReads).toHaveLength(1)

    // Re-open dataset B while the contract read is still in flight.
    await act(async () => {
      fireEvent.click(screen.getByTestId('open-button'))
    })
    await act(async () => {
      h.pickers[1]?.(source())
    })
    await screen.findByTestId('schema-section')

    // The stale read resolves — it must be discarded, not attached.
    await act(async () => {
      h.contractReads[0]?.({ kind: 'too-large' })
    })
    expect(screen.queryByTestId('validation-import-too-large')).toBeNull()
    expect(screen.getByTestId('validation-contract-none')).toBeTruthy()
  })
})

describe('AR-W13 — openDataFile completion guard', () => {
  it('discards a late-resolving open when a newer open already completed', async () => {
    render(<App />)

    // Two opens race before the button re-renders disabled (the guard is the
    // safety net for exactly this window).
    await act(async () => {
      fireEvent.click(screen.getByTestId('open-button'))
      fireEvent.click(screen.getByTestId('open-button'))
    })
    expect(h.pickers).toHaveLength(2)

    // The newer open completes first.
    await act(async () => {
      h.pickers[1]?.(source())
    })
    await screen.findByTestId('schema-section')
    expect(screen.getByTestId('open-status').textContent).toBe('ready')

    // The older picker then resolves dismissed; it must not clobber ready.
    await act(async () => {
      h.pickers[0]?.(null)
    })
    expect(screen.getByTestId('open-status').textContent).toBe('ready')
    expect(screen.getByTestId('schema-section')).toBeTruthy()
  })
})
