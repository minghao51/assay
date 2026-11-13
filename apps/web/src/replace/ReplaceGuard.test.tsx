// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReplaceGuard } from './ReplaceGuard'

/**
 * WF-06 guard component pin (v5 §7, C1–C7). The browser leg lives in
 * `tests/e2e/replace-guard.spec.ts` (real top-layer inertness, real Escape);
 * these pins are the fast complement and the copy gate.
 *
 * Copy is asserted against independent literals, never the imported constants.
 */

const APPROVED = {
  title: 'Replace this session?',
  staged:
    'This session has staged changes that are not saved. Opening another dataset replaces the session, its staged edits, its undo history, and any validation or comparison results.',
  exportBody: 'Session changes are not saved automatically. Export a copy to keep them.',
  stays:
    'If you cancel the file chooser, or the file cannot be opened, this session stays as it is.',
  stay: 'Stay',
  export: 'Export a copy…',
  choose: 'Choose a replacement file…',
} as const

interface Handlers {
  onStay: ReturnType<typeof vi.fn>
  onExport: ReturnType<typeof vi.fn>
  onChoose: ReturnType<typeof vi.fn>
}

function mount(): Handlers {
  const handlers: Handlers = {
    onStay: vi.fn(),
    onExport: vi.fn(),
    onChoose: vi.fn(),
  }
  render(
    <ReplaceGuard
      onStay={handlers.onStay as never}
      onExport={handlers.onExport as never}
      onChoose={handlers.onChoose as never}
    />,
  )
  return handlers
}

function dialog(): HTMLDialogElement {
  const element = screen.getByTestId('replace-guard')
  if (!(element instanceof HTMLDialogElement)) {
    throw new Error(`the guard must be a native <dialog>, got <${element.tagName.toLowerCase()}>`)
  }
  return element
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('WF-06 ReplaceGuard — one native modal', () => {
  it('opens through showModal() with the approved accessible name', () => {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal')
    mount()
    expect(showModal).toHaveBeenCalledTimes(1)
    const surface = dialog()
    expect(surface.open).toBe(true)
    expect(surface.getAttribute('aria-labelledby')).toBe('replace-guard-title')
    expect(document.getElementById('replace-guard-title')?.textContent).toBe(APPROVED.title)
    expect(screen.getByRole('dialog', { name: APPROVED.title })).toBe(surface)
  })

  it('renders C2–C7 byte-exactly, in the approved order', () => {
    mount()
    expect(screen.getByTestId('replace-guard-staged').textContent).toBe(APPROVED.staged)
    expect(screen.getByTestId('replace-guard-export').textContent).toBe(APPROVED.exportBody)
    expect(screen.getByTestId('replace-guard-stays').textContent).toBe(APPROVED.stays)
    expect(screen.getByTestId('replace-stay').textContent).toBe(APPROVED.stay)
    expect(screen.getByTestId('replace-export').textContent).toBe(APPROVED.export)
    expect(screen.getByTestId('replace-choose').textContent).toBe(APPROVED.choose)

    const body = dialog().textContent ?? ''
    const at = (needle: string): number => body.indexOf(needle)
    expect(at(APPROVED.title)).toBe(0)
    expect(at(APPROVED.staged)).toBeGreaterThan(at(APPROVED.title))
    expect(at(APPROVED.exportBody)).toBeGreaterThan(at(APPROVED.staged))
    expect(at(APPROVED.stays)).toBeGreaterThan(at(APPROVED.exportBody))
    expect(at(APPROVED.stay)).toBeGreaterThan(at(APPROVED.stays))
    expect(at(APPROVED.export)).toBeGreaterThan(at(APPROVED.stay))
    expect(at(APPROVED.choose)).toBeGreaterThan(at(APPROVED.export))
  })

  it('prints no pending-change count and no filename/count vocabulary', () => {
    mount()
    const text = dialog().textContent ?? ''
    expect(text).not.toMatch(/\b\d+\b/)
    expect(text).not.toMatch(/\.(parquet|csv|jsonl|json)\b/)
  })

  it('invokes Stay, Export and Choose from their own controls', () => {
    const handlers = mount()
    act(() => {
      fireEvent.click(screen.getByTestId('replace-stay'))
    })
    act(() => {
      fireEvent.click(screen.getByTestId('replace-export'))
    })
    act(() => {
      fireEvent.click(screen.getByTestId('replace-choose'))
    })
    expect(handlers.onStay).toHaveBeenCalledTimes(1)
    expect(handlers.onExport).toHaveBeenCalledTimes(1)
    expect(handlers.onChoose).toHaveBeenCalledTimes(1)
  })

  it('treats the native cancel (Escape) as Stay and never closes itself', () => {
    const handlers = mount()
    const surface = dialog()
    const event = new Event('cancel', { cancelable: true })
    act(() => {
      surface.dispatchEvent(event)
    })
    expect(event.defaultPrevented).toBe(true)
    expect(handlers.onStay).toHaveBeenCalledTimes(1)
    // The parent owns the open state: the dialog is still open after Escape.
    expect(surface.open).toBe(true)
  })

  it('starts focus on the title and contains Tab navigation', () => {
    mount()
    expect(document.activeElement).toBe(document.getElementById('replace-guard-title'))

    const stops = [
      screen.getByTestId('replace-stay'),
      screen.getByTestId('replace-export'),
      screen.getByTestId('replace-choose'),
    ]
    // Tab past the last stop wraps to the first (the app's existing pattern).
    ;(stops[2] as HTMLElement).focus()
    const event = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true, bubbles: true })
    act(() => {
      document.dispatchEvent(event)
    })
    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(stops[0])
  })
})
