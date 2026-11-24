// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EngineTableHandle } from '@assay/engine-duckdb'
import { App } from '../App'
import type { ArrowTableLike } from '../grid/provider'
import {
  IDLE_CAPABILITY,
  IDLE_DROP_HINT,
  IDLE_ENGINE_LINE,
  IDLE_ENGINE_NOTE,
  IDLE_FORMATS,
} from '../lib/app'
import { WelcomeBlock } from './WelcomeBlock'

/**
 * WF-03 subpart 3 (WFD-05 selection §1, 2026-11-23) — the idle-only welcome
 * block, proved at two levels:
 *
 * 1. **The block itself.** Every visible line is the existing `lib/app.ts`
 *    constant, byte-exactly, as the root's own direct children; the block owns
 *    no control, no heading, no live region and no focus target. A source pin
 *    holds the stronger fact: the component contains **no copy literal at
 *    all** — its only string literals are class names, testids, the `status`
 *    role and the constants' import path, listed exhaustively. Subpart 4 (new
 *    first-minute strings) is deferred, so a new sentence here fails this pin
 *    instead of shipping unapproved.
 * 2. **The phase gate in App.** Present in `idle`, absent in `opening`,
 *    `ready` and `error` — the uxv-4 insertion pattern's own leg. The picker
 *    and engine boundaries are the only fakes (the `App.open-status` posture),
 *    and the failure leg additionally proves Open, the example action and the
 *    drop affordance are still there after a failed open, so a welcome block
 *    can never be the thing a user needs to recover from.
 *
 * No copy is re-typed as an expectation literal below: the constants are the
 * single source of truth, and the source pin is what proves no second one was
 * introduced.
 */

const FAKE_HANDLE: EngineTableHandle = { kind: 'table', id: 't1' }

/** Phase controls for the faked engine boundary (App.open-status posture). */
const h = vi.hoisted(() => ({
  deferOpen: false,
  openError: false,
}))

function fakeBatch(): ArrowTableLike {
  const columns = [{ get: () => 1 }, { get: () => 'SG' }]
  return {
    numRows: 1,
    numCols: columns.length,
    getChildAt: (index: number) => columns[index] ?? null,
  }
}

vi.mock('@assay/data-sources/browser', () => ({
  pickDataFile: async (): Promise<{ source: { getFile: () => Promise<File> } }> => ({
    source: { getFile: async () => new File(['id\n1\n'], 'welcome-block.jsonl') },
  }),
}))

vi.mock('../lib/engine', () => ({
  engineClient: {
    open: async () => {
      if (h.deferOpen) await new Promise<never>(() => undefined)
      if (h.openError) throw new Error('corrupt dataset')
      return FAKE_HANDLE
    },
    schema: async () => [{ name: 'id', type: 'BIGINT' }],
    rowCount: async () => 1,
    fetchRange: async () => ({ batch: fakeBatch(), hasMore: false }),
  },
}))

// Orthogonal to this pin (they call the engine on mount and have their own
// e2e coverage); SchemaPanel stays real because the ready frame needs it.
vi.mock('../sql/SqlPanel', () => ({ SqlPanel: () => null }))
vi.mock('../profile/ProfilePanel', () => ({ ProfilePanel: () => null }))

afterEach(() => {
  cleanup()
  h.deferOpen = false
  h.openError = false
})

const SOURCE = readFileSync(
  resolve(process.cwd(), 'apps', 'web', 'src', 'workbench', 'WelcomeBlock.tsx'),
  'utf8',
)

/** Source with comments stripped (prose must never satisfy a pin). */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

/** Every quoted literal in the component, in source order. */
const LITERALS = [...CODE.matchAll(/'([^'\\\n]*)'|"([^"\\\n]*)"/g)].map(
  (match) => match[1] ?? match[2] ?? '',
)

describe('WF-03 subpart 3 — the welcome block composes existing constants only', () => {
  it('renders each existing IDLE_* constant byte-exactly, as direct children', () => {
    render(<WelcomeBlock />)

    const root = screen.getByTestId('idle-intro')
    const lines: readonly (readonly [string, string])[] = [
      ['idle-capability', IDLE_CAPABILITY],
      ['idle-formats', IDLE_FORMATS],
      ['idle-engine-line', IDLE_ENGINE_LINE],
      ['idle-engine-note', IDLE_ENGINE_NOTE],
      ['idle-drop-hint', IDLE_DROP_HINT],
    ]
    for (const [testId, copy] of lines) {
      const line = screen.getByTestId(testId)
      expect(line.textContent, `${testId} is the unchanged lib/app.ts constant`).toBe(copy)
      expect(line.parentElement, `${testId} stays a direct child of the block`).toBe(root)
      expect(line.tagName).toBe('P')
    }
  })

  it('adds no control, heading, live region or focus target', () => {
    render(<WelcomeBlock />)
    const root = screen.getByTestId('idle-intro')

    expect(root.querySelectorAll('button, a, input, select, textarea, [tabindex]')).toHaveLength(0)
    expect(root.querySelectorAll('h1, h2, h3, h4, h5, h6')).toHaveLength(0)
    // Only the drop notice is an announcement, and only App's classified copy
    // reaches it (asserted below); no other line is a live region.
    expect(root.querySelectorAll('[aria-live]')).toHaveLength(0)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('renders App’s classified drop notice verbatim, and nothing when there is none', () => {
    const { unmount } = render(<WelcomeBlock dropNotice="that drop had no file" />)
    const notice = screen.getByTestId('drop-notice')
    expect(notice.textContent).toBe('that drop had no file')
    expect(notice.getAttribute('role')).toBe('status')
    unmount()

    render(<WelcomeBlock />)
    expect(screen.queryByTestId('drop-notice')).toBeNull()
  })

  it('contains no copy literal of its own and no second source', () => {
    // Exhaustive allowlist: the only quoted strings in the component are the
    // class names, the testids, the `status` role and the import path. Any
    // new sentence — approved or not — lands here first.
    expect(
      [...new Set(LITERALS)].sort(),
      'the block introduces no string literal beyond class names, testids, the status role and the import path',
    ).toEqual(
      [
        '../lib/app',
        'drop-notice',
        'idle-capability',
        'idle-drop-hint',
        'idle-drop-hint welcome-block-drop',
        'idle-engine-line',
        'idle-engine-note',
        'idle-formats',
        'idle-intro welcome-block',
        'idle-intro',
        'status',
        'welcome-block-drop-notice',
        'welcome-block-formats',
        'welcome-block-lead',
        'welcome-block-note-line',
        'welcome-block-note',
      ].sort(),
    )
    // The block is static: no state, no effect, no handler, no link, no
    // telemetry, no engine or session import.
    for (const forbidden of [
      /useState/,
      /useEffect/,
      /onClick/,
      /onChange/,
      /onKey/,
      /aria-live/,
      /href=/,
      /telemetry/,
      /engineClient/,
      /role="(button|link)"/,
    ]) {
      expect(CODE, `the welcome block must not contain ${String(forbidden)}`).not.toMatch(forbidden)
    }
    // Every visible line comes from the constants module.
    for (const name of [
      'IDLE_CAPABILITY',
      'IDLE_FORMATS',
      'IDLE_ENGINE_LINE',
      'IDLE_ENGINE_NOTE',
      'IDLE_DROP_HINT',
    ]) {
      expect(CODE.split(name).length - 1, `${name} is imported and rendered`).toBe(2)
    }
  })
})

describe('WF-03 subpart 3 — the block is gated to idle in the real App', () => {
  it('is present in idle', () => {
    render(<App />)
    expect(screen.getByTestId('open-status').getAttribute('data-phase')).toBe('idle')
    expect(screen.getByTestId('idle-intro')).toBeTruthy()
    expect(screen.getByTestId('idle-capability').textContent).toBe(IDLE_CAPABILITY)
  })

  it('is absent while opening', async () => {
    h.deferOpen = true
    render(<App />)
    expect(screen.getByTestId('idle-intro')).toBeTruthy()

    await act(async () => {
      fireEvent.click(screen.getByTestId('open-button'))
    })

    expect(screen.getByTestId('open-status').getAttribute('data-phase')).toBe('opening')
    expect(screen.queryByTestId('idle-intro')).toBeNull()
    expect(screen.queryByTestId('idle-capability')).toBeNull()
    expect(screen.queryByTestId('idle-drop-hint')).toBeNull()
  })

  it('is absent once a dataset is ready', async () => {
    render(<App />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('open-button'))
    })
    await screen.findByTestId('schema-section')

    expect(screen.getByTestId('open-status').getAttribute('data-phase')).toBe('ready')
    expect(screen.queryByTestId('idle-intro')).toBeNull()
    expect(screen.queryByTestId('idle-engine-line')).toBeNull()
    expect(screen.queryByTestId('idle-drop-hint')).toBeNull()
  })

  it('is absent on an open error, and the controls survive it', async () => {
    h.openError = true
    render(<App />)

    await act(async () => {
      fireEvent.click(screen.getByTestId('open-button'))
    })
    await screen.findByTestId('open-error')

    expect(screen.getByTestId('open-status').getAttribute('data-phase')).toBe('error')
    expect(screen.queryByTestId('idle-intro')).toBeNull()
    expect(screen.queryByTestId('idle-capability')).toBeNull()
    // Recovery is never behind the welcome block: the open paths survive it.
    expect(screen.getByTestId('open-button').hasAttribute('disabled')).toBe(false)
    expect(screen.getByTestId('open-error-retry')).toBeTruthy()

    // And the retry really opens: the next attempt reaches `ready`.
    h.openError = false
    await act(async () => {
      fireEvent.click(screen.getByTestId('open-error-retry'))
    })
    await screen.findByTestId('schema-section')
    expect(screen.getByTestId('open-status').getAttribute('data-phase')).toBe('ready')
    expect(screen.queryByTestId('idle-intro')).toBeNull()
  })
})
