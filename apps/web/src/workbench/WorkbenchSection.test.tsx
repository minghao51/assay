// SPDX-License-Identifier: AGPL-3.0-or-later

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchSection } from './WorkbenchSection'
import { WORKBENCH_SECTION_PURPOSES } from './tasks'

/**
 * D02a: the section-shell contract asserted directly on the extracted
 * component. The full shell behaviour is still pinned through the real App
 * composition root (`App.headings`, `App.section-purposes`,
 * `App.section-summaries`, `App.shell`, `App.panel-boundary`); these cases
 * only cover what App cannot reach because it never calls the component that
 * way — an `inner`-disclosure section being handed a summary — plus the
 * mounted-while-collapsed rule that makes the persistent grid possible
 * (ADR 0044). No render-count or engine seam is involved: this component has
 * no hooks and no engine/session access.
 */

afterEach(cleanup)

describe('WorkbenchSection', () => {
  it('managed + open: one toggle, aria-expanded true, purpose as description, body visible', () => {
    render(
      <WorkbenchSection id="history" open onToggle={() => undefined}>
        <p>body</p>
      </WorkbenchSection>,
    )
    const section = document.getElementById('section-history')
    expect(section).not.toBeNull()
    expect(section?.getAttribute('data-section')).toBe('history')
    expect(section?.getAttribute('data-task')).toBe('change')
    const toggle = screen.getByTestId('section-toggle-history')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    // The accessible name stays `Expand/Collapse <Title>`; the purpose line is
    // the DESCRIPTION (ug-13/R-14), never part of the name.
    expect(toggle.getAttribute('aria-label')).toBe('Collapse History')
    expect(toggle.getAttribute('aria-controls')).toBe('section-history-content')
    expect(toggle.getAttribute('aria-describedby')).toBe('section-history-purpose')
    expect(screen.getByTestId('section-purpose-history').textContent).toBe(
      WORKBENCH_SECTION_PURPOSES.history,
    )
    expect(document.getElementById('section-history-content')?.hasAttribute('hidden')).toBe(false)
    expect(screen.getByText('body')).not.toBeNull()
  })

  it('managed + collapsed: body stays MOUNTED and hidden, toggle asks to expand', () => {
    render(
      <WorkbenchSection id="history" open={false} onToggle={() => undefined}>
        <p>body</p>
      </WorkbenchSection>,
    )
    const toggle = screen.getByTestId('section-toggle-history')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.getAttribute('aria-label')).toBe('Expand History')
    const content = document.getElementById('section-history-content')
    expect(content?.hasAttribute('hidden')).toBe(true)
    // Mounted, not unmounted: the grid/panel keeps its fetch and local state
    // (the ADR 0044 persistent-grid / ADR 0022 rendering-position rule).
    expect(content?.querySelector('p')?.textContent).toBe('body')
  })

  it('managed: the summary is a SECOND description while it exists and nothing at null', () => {
    const { rerender } = render(
      <WorkbenchSection id="validation" open={false} summary="Validation · 2 failing">
        <p>body</p>
      </WorkbenchSection>,
    )
    const toggle = screen.getByTestId('section-toggle-validation')
    expect(toggle.getAttribute('aria-describedby')).toBe(
      'section-validation-purpose section-validation-summary',
    )
    expect(screen.getByTestId('section-summary-validation').textContent).toBe(
      'Validation · 2 failing',
    )

    rerender(
      <WorkbenchSection id="validation" open={false} summary={null}>
        <p>body</p>
      </WorkbenchSection>,
    )
    expect(toggle.getAttribute('aria-describedby')).toBe('section-validation-purpose')
    expect(screen.queryByTestId('section-summary-validation')).toBeNull()
  })

  it('inner: no shell toggle, purpose line above the body, and a summary is IGNORED', () => {
    render(
      <WorkbenchSection id="schema" disclosure="inner" open summary="ignored by inner">
        <p>body</p>
      </WorkbenchSection>,
    )
    // Schema/Profile/Filters own their `aria-expanded` control; a second shell
    // toggle never exists (ux-3/ux-4), and their collapsed idiom is their own.
    expect(screen.queryByTestId('section-toggle-schema')).toBeNull()
    const purpose = screen.getByTestId('section-purpose-schema')
    expect(purpose.tagName).toBe('P')
    expect(purpose.id).toBe('section-schema-purpose')
    expect(purpose.textContent).toBe(WORKBENCH_SECTION_PURPOSES.schema)
    expect(screen.queryByTestId('section-summary-schema')).toBeNull()
  })

  it('managed: clicking the toggle reports THIS section id and nothing else', () => {
    const onToggle = vi.fn()
    render(
      <WorkbenchSection id="history" open={false} onToggle={onToggle}>
        <p>body</p>
      </WorkbenchSection>,
    )
    fireEvent.click(screen.getByTestId('section-toggle-history'))
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onToggle).toHaveBeenCalledWith('history')
  })
})
