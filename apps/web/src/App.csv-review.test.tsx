// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineCsvPreviewResult } from '@assay/engine-duckdb'
import { App } from './App'
import type { ArrowTableLike } from './grid/provider'

/**
 * EW-03I-b — the CSV review wired into the REAL `App` composition root, with
 * only the picker/engine boundaries faked (the `App.replace`/`App.open-status`
 * posture). The dialog, the option model, the WF-06 gate/intent/notice
 * machinery and the single open chain are all real code.
 *
 * What is pinned here, one observable per claim:
 *
 * 1. **Quick open is unchanged** — the ordinary Open control sends `open` with
 *    NO options argument and never calls `csvPreview` (byte-identical request).
 * 2. **The review is non-adopting** — the surface appears, `csvPreview` runs,
 *    and `open` has not been called.
 * 3. **Adoption carries the reviewed set, once** — the option set the sample
 *    was read with reaches `engine/open`, in idle and in a ready session (the
 *    latter through the existing WF-06 preparation/adoption pair).
 * 4. **Abandonment opens nothing, keeps the live session, and says "stopped
 *    reviewing"** — including that a preview result arriving after the stop
 *    never resurrects the surface.
 * 5. **A non-CSV pick from the review control keeps today's path** — ordinary
 *    `open`, no options, no review surface.
 *
 * Copy is asserted as independent literals (never imported from `csv/copy`).
 */

const STOPPED_IDLE = 'You stopped reviewing. Nothing was opened.'

/** The ready-mode abandonment notice, asserted as one rendered string. */
const STOPPED_READY = `${STOPPED_IDLE} This session is unchanged.`

interface Pick {
  readonly name: string
  readonly cancel?: boolean
}

interface OpenArgs {
  readonly name: string
  readonly options: Record<string, unknown> | undefined
  readonly argumentCount: number
}

interface PreviewArgs {
  readonly options: Record<string, unknown> | undefined
  readonly sampleRows: number | undefined
}

interface VirtualItem {
  index: number
  key: string
  start: number
  size: number
}

const h = vi.hoisted(() => ({
  rows: [{ index: 0, key: '0', start: 0, size: 28 }] as VirtualItem[],
  picks: [] as Pick[],
  pickRequests: 0,
  openArgs: [] as OpenArgs[],
  previewArgs: [] as PreviewArgs[],
  /** Holds the NEXT preview read so a late result can be settled by the test. */
  previewGate: null as Promise<void> | null,
  beginCalls: 0,
  token: 0,
  resets: [] as Array<() => void>,
  session: null as Record<string, unknown> | null,
  nextTableId: 1,
  events: [] as string[],
}))

const SCHEMA = [
  { name: 'id', type: 'BIGINT' },
  { name: 'name', type: 'VARCHAR' },
  { name: 'score', type: 'DOUBLE' },
]

function fakeBatch(): ArrowTableLike {
  const cells = SCHEMA.map((_column, index) => ({ get: () => (index === 0 ? 1 : 'x') }))
  return {
    numRows: 1,
    numCols: cells.length,
    getChildAt: (index: number) => cells[index] ?? null,
  }
}

type SampleBatch = NonNullable<EngineCsvPreviewResult['sample']>['batch']

function previewResult(): EngineCsvPreviewResult {
  const columns = [
    [1, 2],
    ['anna', 'braedon'],
    [10, 22],
  ]
  const batch: ArrowTableLike = {
    numRows: 2,
    numCols: columns.length,
    getChildAt: (index: number) => {
      const values = columns[index]
      if (values === undefined) return null
      return { get: (rowIndex: number) => values[rowIndex] }
    },
  }
  return {
    previewId: 'p1',
    sniff: {
      delimiter: ';',
      quote: '"',
      escape: '',
      newLineDelimiter: '\n',
      comment: '',
      skipRows: 0,
      hasHeader: true,
      columns: SCHEMA,
      dateFormat: null,
      timestampFormat: null,
      prompt: "read_csv('preview_p1', delim = ';')",
    },
    effectiveOptions: {},
    sample: {
      batch: batch as unknown as SampleBatch,
      hasMore: false,
      rowCap: 50,
    },
  }
}

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({
    getVirtualItems: () => h.rows,
    getTotalSize: () => h.rows.length * 28,
    scrollToIndex: vi.fn(),
  }),
}))

vi.mock('@assay/data-sources/browser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@assay/data-sources/browser')>()
  return {
    ...actual,
    pickDataFile: async (): Promise<{ source: { getFile: () => Promise<File> } } | null> => {
      h.pickRequests += 1
      const next = h.picks.shift()
      if (next === undefined || next.cancel === true) return null
      const file = new File(['id;name;score\n1;anna;10\n2;braedon;22\n'], next.name)
      return { source: { getFile: async () => file } }
    },
  }
})

vi.mock('./sessions/session-reset', () => ({
  useDatasetSession: () => {
    if (h.session === null) {
      h.session = {
        tokenRef: {
          get current(): number {
            return h.token
          },
        },
        beginSession: () => {
          h.beginCalls += 1
          h.token += 1
          for (const reset of h.resets) reset()
          return h.token
        },
        registerReset: (reset: () => void) => {
          h.resets.push(reset)
          return () => {
            h.resets = h.resets.filter((registered) => registered !== reset)
          }
        },
      }
    }
    return h.session
  },
}))

vi.mock('./lib/engine', () => {
  const engineClient = {
    open: async (...args: [{ name: string }, Record<string, unknown>?]) => {
      const [source, options] = args
      h.openArgs.push({
        name: source.name,
        options,
        argumentCount: args.length,
      })
      const id = `t${String(h.nextTableId)}`
      h.nextTableId += 1
      return { kind: 'table', id }
    },
    csvPreview: async (
      _source: unknown,
      options?: Record<string, unknown>,
      sampleRows?: number,
    ): Promise<EngineCsvPreviewResult> => {
      h.previewArgs.push({ options, sampleRows })
      const gate = h.previewGate
      if (gate !== null) {
        h.previewGate = null
        await gate
      }
      return previewResult()
    },
    schema: async () => SCHEMA,
    rowCount: async () => 2,
    fetchRange: async () => ({ batch: fakeBatch(), hasMore: false }),
    overlaySchema: async () => SCHEMA,
    overlayRowCount: async () => 2,
    fetchOverlayRange: async () => ({ batch: fakeBatch(), hasMore: false }),
    overlayCastCheck: async () => ({ hasNonConvertibleValues: false }),
    dispose: async () => undefined,
  }
  return { engineClient }
})

vi.mock('./profile/ProfilePanel', () => ({ ProfilePanel: () => null }))

function fakeRuntime(): Record<string, unknown> {
  return {
    surface: 'web',
    hardOff: false,
    endpointConfigured: false,
    emit: (name: string) => {
      h.events.push(name)
    },
    flush: async () => undefined,
    getPreference: () => 'off',
    setPreference: () => undefined,
    isEnabledNow: () => false,
    shouldShowDisclosure: () => false,
    markDisclosureShown: () => undefined,
    dispose: () => undefined,
  }
}

beforeEach(() => {
  h.rows = [{ index: 0, key: '0', start: 0, size: 28 }]
  h.picks = []
  h.pickRequests = 0
  h.openArgs = []
  h.previewArgs = []
  h.previewGate = null
  h.beginCalls = 0
  h.token = 0
  h.resets = []
  h.session = null
  h.nextTableId = 1
  h.events = []
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

async function waitForIdle(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByTestId('open-status').getAttribute('data-phase')).toBe('idle')
  })
}

async function waitForReady(): Promise<void> {
  await waitFor(
    () => {
      expect(screen.getByTestId('open-status').getAttribute('data-phase')).toBe('ready')
    },
    { timeout: 5000 },
  )
}

async function waitForReview(): Promise<void> {
  await screen.findByTestId('csv-review')
  await screen.findByTestId('csv-review-sample-table')
}

function reviewText(testId: string): string {
  return screen.getByTestId(testId).textContent ?? ''
}

describe('CSV review — the default open path is byte-identical', () => {
  it('sends engine/open with no options argument and never previews', async () => {
    h.picks = [{ name: 'plain.csv' }]
    render(<App telemetry={fakeRuntime() as never} />)
    await waitForIdle()
    await act(async () => {
      fireEvent.click(screen.getByTestId('open-button'))
    })
    await waitForReady()
    expect(h.openArgs).toHaveLength(1)
    // The exact pre-EW-03I request: `open(source)` with a single argument, so
    // no options field is ever composed.
    expect(h.openArgs[0]?.argumentCount).toBe(1)
    expect(h.openArgs[0]?.options).toBeUndefined()
    expect(h.previewArgs).toHaveLength(0)
    expect(screen.queryByTestId('csv-review')).toBeNull()
  })

  it('offers the review as a separate, explicit control in the idle surface', async () => {
    render(<App telemetry={fakeRuntime() as never} />)
    await waitForIdle()
    expect(screen.getByTestId('csv-review-button').textContent).toBe('Review CSV options…')
    expect(screen.getByTestId('csv-review-helper').textContent).toBe(
      'Choose a .csv file to see the dialect the reader guesses, the column types, and a bounded sample before anything is opened.',
    )
    // The default control is untouched beside it.
    expect(screen.getByTestId('open-button').textContent).toBe('Open a data file…')
  })
})

describe('CSV review — idle: non-adopting review, then adoption with the reviewed set', () => {
  it('reads a preview without opening anything, then adopts the reviewed options once', async () => {
    h.picks = [{ name: 'reviewed.csv' }]
    render(<App telemetry={fakeRuntime() as never} />)
    await waitForIdle()
    await act(async () => {
      fireEvent.click(screen.getByTestId('csv-review-button'))
    })
    await waitForReview()
    // Non-adopting: the preview ran, the open chain did not.
    expect(h.previewArgs).toHaveLength(1)
    expect(h.previewArgs[0]?.options).toBeUndefined()
    expect(h.openArgs).toHaveLength(0)
    expect(screen.getByTestId('open-status').getAttribute('data-phase')).toBe('idle')

    fireEvent.change(screen.getByTestId('csv-review-delim'), { target: { value: ',' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('csv-review-update'))
    })
    await waitFor(() => {
      expect(h.previewArgs).toHaveLength(2)
    })
    expect(h.previewArgs[1]?.options).toEqual({ delim: ',' })

    await act(async () => {
      fireEvent.click(screen.getByTestId('csv-review-adopt'))
    })
    await waitForReady()
    expect(h.openArgs).toHaveLength(1)
    // The reviewed set rides the open (ADR 0049 acceptance resolution 5) and
    // the surface is gone.
    expect(h.openArgs[0]?.options).toEqual({ delim: ',' })
    expect(screen.queryByTestId('csv-review')).toBeNull()
    // The existing open telemetry event, unchanged and unextended.
    expect(h.events.filter((name) => name === 'dataset_opened')).toHaveLength(1)
  })

  it('says "stopped reviewing", opens nothing, and drops a late preview result', async () => {
    h.picks = [{ name: 'reviewed.csv' }]
    render(<App telemetry={fakeRuntime() as never} />)
    await waitForIdle()
    await act(async () => {
      fireEvent.click(screen.getByTestId('csv-review-button'))
    })
    await waitForReview()

    // Hold the next read, then abandon the review while it is in flight.
    let release: (() => void) | null = null
    h.previewGate = new Promise<void>((resolve) => {
      release = resolve
    })
    fireEvent.change(screen.getByTestId('csv-review-delim'), { target: { value: '|' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('csv-review-update'))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('csv-review-stop'))
    })
    expect(screen.queryByTestId('csv-review')).toBeNull()
    expect(reviewText('csv-review-stopped')).toBe(STOPPED_IDLE)
    expect(screen.getByTestId('open-status').getAttribute('data-phase')).toBe('idle')

    // The late result settles after abandonment: it must not resurrect the
    // surface and must not open anything.
    await act(async () => {
      release?.()
    })
    await Promise.resolve()
    expect(screen.queryByTestId('csv-review')).toBeNull()
    expect(h.openArgs).toHaveLength(0)
    expect(screen.getByTestId('open-status').getAttribute('data-phase')).toBe('idle')
  })

  it('keeps the ordinary open path for a non-.csv pick from the review control', async () => {
    h.picks = [{ name: 'plain.parquet' }]
    render(<App telemetry={fakeRuntime() as never} />)
    await waitForIdle()
    await act(async () => {
      fireEvent.click(screen.getByTestId('csv-review-button'))
    })
    await waitForReady()
    expect(screen.queryByTestId('csv-review')).toBeNull()
    expect(h.previewArgs).toHaveLength(0)
    expect(h.openArgs).toHaveLength(1)
    expect(h.openArgs[0]?.options).toBeUndefined()
  })

  it('opens nothing when the chooser is dismissed', async () => {
    h.picks = [{ name: 'x.csv', cancel: true }]
    render(<App telemetry={fakeRuntime() as never} />)
    await waitForIdle()
    await act(async () => {
      fireEvent.click(screen.getByTestId('csv-review-button'))
    })
    await waitFor(() => {
      expect(h.pickRequests).toBe(1)
    })
    expect(screen.queryByTestId('csv-review')).toBeNull()
    expect(h.previewArgs).toHaveLength(0)
    expect(h.openArgs).toHaveLength(0)
    expect(screen.getByTestId('open-status').getAttribute('data-phase')).toBe('idle')
  })
})

describe('CSV review — ready: the existing WF-06 machinery carries the review', () => {
  async function openFirstDataset(): Promise<void> {
    h.picks = [{ name: 'first.csv' }]
    render(<App telemetry={fakeRuntime() as never} />)
    await waitForIdle()
    await act(async () => {
      fireEvent.click(screen.getByTestId('open-button'))
    })
    await waitForReady()
    expect(h.openArgs).toHaveLength(1)
    expect(h.openArgs[0]?.options).toBeUndefined()
  }

  it('reviews a CSV and adopts it through a fresh open carrying the reviewed options', async () => {
    await openFirstDataset()
    h.picks = [{ name: 'reviewed.csv' }]
    await act(async () => {
      fireEvent.click(screen.getByTestId('csv-review-open'))
    })
    await waitForReview()
    // The live session is untouched while the review is up.
    expect(h.openArgs).toHaveLength(1)
    expect(h.beginCalls).toBe(1)

    fireEvent.change(screen.getByTestId('csv-review-all-varchar'), {
      target: { value: 'yes' },
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('csv-review-update'))
    })
    await waitFor(() => {
      expect(h.previewArgs).toHaveLength(2)
    })
    expect(h.previewArgs[1]?.options).toEqual({ all_varchar: true })

    await act(async () => {
      fireEvent.click(screen.getByTestId('csv-review-adopt'))
    })
    await waitFor(() => {
      expect(h.openArgs).toHaveLength(2)
    })
    // A fresh engine/open with the reviewed set — the existing exactly-once
    // adoption, not a promotion and not a second registry writer.
    expect(h.openArgs[1]?.options).toEqual({ all_varchar: true })
    expect(h.beginCalls).toBe(2)
    expect(screen.queryByTestId('csv-review')).toBeNull()
    await waitForReady()
  })

  it('leaves the live session as it is when the review is stopped', async () => {
    await openFirstDataset()
    h.picks = [{ name: 'reviewed.csv' }]
    await act(async () => {
      fireEvent.click(screen.getByTestId('csv-review-open'))
    })
    await waitForReview()
    await act(async () => {
      fireEvent.click(screen.getByTestId('csv-review-stop'))
    })
    expect(screen.queryByTestId('csv-review')).toBeNull()
    expect(reviewText('csv-review-stopped')).toBe(STOPPED_READY)
    expect(h.openArgs).toHaveLength(1)
    // No second session: abandonment is not a lifecycle event.
    expect(h.beginCalls).toBe(1)
    expect(screen.getByTestId('open-status').getAttribute('data-phase')).toBe('ready')
  })

  it('says so honestly instead of implying a release', async () => {
    await openFirstDataset()
    h.picks = [{ name: 'reviewed.csv' }]
    await act(async () => {
      fireEvent.click(screen.getByTestId('csv-review-open'))
    })
    await waitForReview()
    await act(async () => {
      fireEvent.click(screen.getByTestId('csv-review-stop'))
    })
    const notice = reviewText('csv-review-stopped')
    // ADR 0049 item 7: no abort claim, and no release claim either (there is no
    // host-reachable release op — envelope §5a).
    expect(notice).not.toMatch(/abort/i)
    expect(notice).not.toMatch(/releas/i)
  })

  it('clears the stop notice on the next gesture', async () => {
    await openFirstDataset()
    h.picks = [{ name: 'reviewed.csv' }]
    await act(async () => {
      fireEvent.click(screen.getByTestId('csv-review-open'))
    })
    await waitForReview()
    await act(async () => {
      fireEvent.click(screen.getByTestId('csv-review-stop'))
    })
    expect(screen.queryByTestId('csv-review-stopped')).not.toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByTestId('open-button'))
    })
    await waitFor(() => {
      expect(screen.queryByTestId('csv-review-stopped')).toBeNull()
    })
  })

  it('never lets a remembered review path hijack the plain Open control', async () => {
    await openFirstDataset()
    // Choose the review path once, then abandon it.
    h.picks = [{ name: 'reviewed.csv' }]
    await act(async () => {
      fireEvent.click(screen.getByTestId('csv-review-open'))
    })
    await waitForReview()
    await act(async () => {
      fireEvent.click(screen.getByTestId('csv-review-stop'))
    })
    // The Open control states its own path: an ordinary candidate open, no
    // review surface, and no options argument.
    h.picks = [{ name: 'next.csv' }]
    await act(async () => {
      fireEvent.click(screen.getByTestId('open-button'))
    })
    await waitFor(() => {
      expect(h.openArgs).toHaveLength(2)
    })
    expect(screen.queryByTestId('csv-review')).toBeNull()
    expect(h.previewArgs).toHaveLength(1)
    expect(h.openArgs[1]?.options).toBeUndefined()
  })

  it('keeps the ordinary candidate path for a non-.csv pick from the ready control', async () => {
    await openFirstDataset()
    h.picks = [{ name: 'orders.parquet' }]
    await act(async () => {
      fireEvent.click(screen.getByTestId('csv-review-open'))
    })
    await waitFor(() => {
      expect(h.openArgs).toHaveLength(2)
    })
    expect(h.openArgs[1]?.options).toBeUndefined()
    expect(h.previewArgs).toHaveLength(0)
    expect(screen.queryByTestId('csv-review')).toBeNull()
    await waitForReady()
  })
})
