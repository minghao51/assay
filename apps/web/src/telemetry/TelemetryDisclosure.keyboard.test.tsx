// SPDX-License-Identifier: AGPL-3.0-or-later

import { StrictMode } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DISCLOSURE_REVISION,
  WEB_DISCLOSURE_KEEP_ON_LABEL,
  WEB_DISCLOSURE_TURN_OFF_LABEL,
} from '@assay/telemetry'
import { TelemetryProvider } from './TelemetryContext'
import { TelemetryDisclosure } from './TelemetryDisclosure'
import type { WebTelemetryRuntime } from './runtime'

/**
 * ux-a3 — the disclosure's keyboard life cycle (the audit's "modal that is not
 * modal" finding).
 *
 * The browser leg (`tests/visual/telemetry-disclosure-theme.spec.ts`) proves
 * the genuine native behaviour — top-layer inertness, Tab containment and
 * `:modal` in Chromium. These component pins are the fast, precise complement:
 *
 * 1. the surface really IS a native `<dialog>` opened with `showModal()` (a
 *    regression to a decorated `<section>` fails here);
 * 2. initial focus is the neutral title, before either choice;
 * 3. Tab/Shift+Tab wrap explicitly at the dialog boundary (the native modal
 *    already contains sequential navigation; this pins the wrap logic);
 * 4. Escape consumes the native `cancel` event: no dismissal, no preference
 *    write, no extra event — ADR 0037 consent stays explicit-only;
 * 5. unmount closes the dialog and restores the still-connected pre-open
 *    focus owner (never a detached node), and nothing leaks between mounts;
 * 6. StrictMode's double setup/cleanup still records ONE disclosure_shown.
 *
 * Privacy: the fake runtime never touches the network, and the assertions
 * only inspect emitted event names/counters.
 */

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

function renderDisclosure(
  runtime: WebTelemetryRuntime,
  onDismiss: () => void = () => undefined,
  wrapper?: (children: React.ReactElement) => React.ReactElement,
) {
  const tree = (
    <TelemetryProvider runtime={runtime}>
      <TelemetryDisclosure onDismiss={onDismiss} />
    </TelemetryProvider>
  )
  return render(wrapper === undefined ? tree : wrapper(tree))
}

/** The disclosure surface, typed as the native element it must be. */
function disclosure(): HTMLDialogElement {
  const element = screen.getByTestId('telemetry-disclosure')
  if (!(element instanceof HTMLDialogElement)) {
    throw new Error(`disclosure must be a native <dialog>, got <${element.tagName.toLowerCase()}>`)
  }
  return element
}

function title(): HTMLElement {
  const element = document.getElementById('telemetry-disclosure-title')
  if (element === null) throw new Error('disclosure title missing')
  return element
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('TelemetryDisclosure — native modal surface (ux-a3)', () => {
  it('renders a native <dialog> opened as a modal, with the preserved affordances', () => {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal')
    renderDisclosure(fakeRuntime())

    const dialog = disclosure()
    expect(dialog.tagName).toBe('DIALOG')
    expect(showModal).toHaveBeenCalledTimes(1)
    expect(dialog.open).toBe(true)
    // The pre-existing contract (testid/copy/actions) is unchanged.
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(screen.getByText(WEB_DISCLOSURE_KEEP_ON_LABEL)).toBeTruthy()
    expect(screen.getByText(WEB_DISCLOSURE_TURN_OFF_LABEL)).toBeTruthy()
  })

  it('starts focus on the neutral title rather than either choice', () => {
    renderDisclosure(fakeRuntime())
    expect(title().getAttribute('tabindex')).toBe('-1')
    expect(document.activeElement).toBe(title())
    expect(document.activeElement).not.toBe(screen.getByTestId('telemetry-keep-on'))
    expect(document.activeElement).not.toBe(screen.getByTestId('telemetry-turn-off'))
    // The title is a reading start, not a control: its content is the §6.3
    // label, unchanged.
    expect(title().textContent).toBe('Telemetry disclosure')
  })
})

describe('TelemetryDisclosure — Tab containment (ux-a3)', () => {
  it('wraps Tab from the last choice to the first and Shift+Tab back', () => {
    renderDisclosure(fakeRuntime())
    const keepOn = screen.getByTestId('telemetry-keep-on')
    const turnOff = screen.getByTestId('telemetry-turn-off')

    // Tab on the last action wraps to the first (the event is consumed).
    turnOff.focus()
    expect(fireEvent.keyDown(turnOff, { key: 'Tab' })).toBe(false)
    expect(document.activeElement).toBe(keepOn)

    // Shift+Tab on the first action wraps to the last.
    keepOn.focus()
    expect(fireEvent.keyDown(keepOn, { key: 'Tab', shiftKey: true })).toBe(false)
    expect(document.activeElement).toBe(turnOff)
  })

  it('sends Tab and Shift+Tab from the initial title into the actions', () => {
    renderDisclosure(fakeRuntime())
    const keepOn = screen.getByTestId('telemetry-keep-on')
    const turnOff = screen.getByTestId('telemetry-turn-off')

    title().focus()
    expect(fireEvent.keyDown(title(), { key: 'Tab' })).toBe(false)
    expect(document.activeElement).toBe(keepOn)

    title().focus()
    expect(fireEvent.keyDown(title(), { key: 'Tab', shiftKey: true })).toBe(false)
    expect(document.activeElement).toBe(turnOff)
  })

  it('leaves an ordinary forward Tab inside the actions to the browser', () => {
    renderDisclosure(fakeRuntime())
    const keepOn = screen.getByTestId('telemetry-keep-on')
    keepOn.focus()
    // Between the two actions the native sequential navigation must run: the
    // handler only owns the boundary, never a general "trap" that could fight
    // the browser's own focus order.
    expect(fireEvent.keyDown(keepOn, { key: 'Tab' })).toBe(true)
    expect(document.activeElement).toBe(keepOn)
  })
})

describe('TelemetryDisclosure — Escape is not consent (ux-a3)', () => {
  it('consumes the native cancel event without dismissing or writing a preference', () => {
    const runtime = fakeRuntime()
    const onDismiss = vi.fn()
    renderDisclosure(runtime, onDismiss)
    const dialog = disclosure()

    const cancel = new Event('cancel', { cancelable: true })
    dialog.dispatchEvent(cancel)

    // The UA would close the dialog on cancel; we prevent that.
    expect(cancel.defaultPrevented).toBe(true)
    expect(dialog.open).toBe(true)
    expect(onDismiss).not.toHaveBeenCalled()
    expect(runtime.setPreference).not.toHaveBeenCalled()
    // No new event beyond the one disclosure_shown.
    expect(runtime.emit).toHaveBeenCalledTimes(1)
    expect(runtime.emit).toHaveBeenCalledWith('disclosure_shown', {
      disclosure_revision: DISCLOSURE_REVISION,
    })
  })

  it('also ignores an Escape keydown: neither choice is taken implicitly', () => {
    const runtime = fakeRuntime()
    const onDismiss = vi.fn()
    renderDisclosure(runtime, onDismiss)

    // Escape is pressed while focus sits on the initial title (as it does on
    // first run) and while it sits on an action.
    fireEvent.keyDown(title(), { key: 'Escape' })
    screen.getByTestId('telemetry-keep-on').focus()
    fireEvent.keyDown(screen.getByTestId('telemetry-keep-on'), { key: 'Escape' })

    expect(onDismiss).not.toHaveBeenCalled()
    expect(runtime.setPreference).not.toHaveBeenCalled()
    expect(disclosure().open).toBe(true)
  })

  it('the explicit choices keep their exact consent semantics', () => {
    // "Turn it off" writes 'off' and dismisses; "Keep on" dismisses only.
    const offRuntime = fakeRuntime()
    const offDismiss = vi.fn()
    renderDisclosure(offRuntime, offDismiss)
    fireEvent.click(screen.getByTestId('telemetry-turn-off'))
    expect(offRuntime.setPreference).toHaveBeenCalledWith('off')
    expect(offDismiss).toHaveBeenCalledTimes(1)
    cleanup()

    const keepRuntime = fakeRuntime()
    const keepDismiss = vi.fn()
    renderDisclosure(keepRuntime, keepDismiss)
    fireEvent.click(screen.getByTestId('telemetry-keep-on'))
    expect(keepRuntime.setPreference).not.toHaveBeenCalled()
    expect(keepDismiss).toHaveBeenCalledTimes(1)
  })
})

describe('TelemetryDisclosure — focus restoration and mount hygiene (ux-a3)', () => {
  it('returns focus to the still-connected pre-open owner on unmount', () => {
    const opener = document.createElement('button')
    opener.textContent = 'grid row'
    document.body.append(opener)
    opener.focus()
    expect(document.activeElement).toBe(opener)

    const { unmount } = renderDisclosure(fakeRuntime())
    expect(document.activeElement).toBe(title())

    unmount()
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it('never restores focus to a pre-open owner that was detached meanwhile', () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()

    const { unmount } = renderDisclosure(fakeRuntime())
    // The opener unmounts (e.g. the grid re-rendered) while the modal is open.
    opener.remove()
    unmount()

    expect(opener.isConnected).toBe(false)
    expect(document.activeElement).not.toBe(opener)
  })

  it('closes the dialog on unmount so no top-layer entry or listener leaks', () => {
    const dialog = (() => {
      const { unmount } = renderDisclosure(fakeRuntime())
      const element = disclosure()
      unmount()
      return element
    })()
    // The component's cleanup closed the surface; a leaked `open` dialog would
    // leave the page inert after the disclosure is gone.
    expect(dialog.open).toBe(false)
    // The cancel listener went with it: dispatching cancel no longer consumes
    // the event (nothing is left to prevent it).
    const cancel = new Event('cancel', { cancelable: true })
    dialog.dispatchEvent(cancel)
    expect(cancel.defaultPrevented).toBe(false)
  })

  it('records and emits disclosure_shown exactly once under StrictMode', () => {
    const runtime = fakeRuntime()
    renderDisclosure(
      runtime,
      () => undefined,
      (children) => <StrictMode>{children}</StrictMode>,
    )

    expect(runtime.markDisclosureShown).toHaveBeenCalledTimes(1)
    expect(runtime.emit).toHaveBeenCalledTimes(1)
    expect(runtime.emit).toHaveBeenCalledWith('disclosure_shown', {
      disclosure_revision: DISCLOSURE_REVISION,
    })
    // The double setup/cleanup leaves ONE open modal, focused on the title.
    expect(disclosure().open).toBe(true)
    expect(document.activeElement).toBe(title())
  })
})
