// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { TaskNav } from './TaskNav'
import type { WorkbenchSectionId, WorkbenchTaskId } from './tasks'

function Harness({
  onReveal = () => undefined,
  initial = 'explore',
}: {
  readonly onReveal?: (id: WorkbenchSectionId) => void
  readonly initial?: WorkbenchTaskId
}) {
  const [task, setTask] = useState<WorkbenchTaskId>(initial)
  return <TaskNav activeTask={task} onSelectTask={setTask} onRevealSection={onReveal} />
}

afterEach(cleanup)

describe('TaskNav — radio-group semantics', () => {
  it('renders four radio choices and never claims tabs', () => {
    const { container } = render(<Harness />)
    const radios = screen.getAllByRole('radio')
    expect(radios.map((radio) => radio.textContent)).toEqual([
      'Explore',
      'Check',
      'Change',
      'Prepare',
    ])
    expect(container.querySelector('[role="tab"]')).toBeNull()
    expect(container.querySelector('[role="tabpanel"]')).toBeNull()
    expect(screen.getByRole('radiogroup', { name: 'Workbench task' })).toBeTruthy()
  })

  it('checks exactly one choice and roves the tab stop', () => {
    render(<Harness />)
    const radios = screen.getAllByRole('radio')
    expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual([
      'true',
      'false',
      'false',
      'false',
    ])
    expect(radios.map((radio) => radio.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1'])
  })

  it('moves and selects with Arrow keys, and Home/End', () => {
    render(<Harness />)
    const explore = screen.getByRole('radio', { name: 'Explore' })
    explore.focus()
    fireEvent.keyDown(explore, { key: 'ArrowRight' })
    expect(screen.getByRole('radio', { name: 'Check' }).getAttribute('aria-checked')).toBe('true')
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Check' }))

    const check = screen.getByRole('radio', { name: 'Check' })
    fireEvent.keyDown(check, { key: 'End' })
    expect(screen.getByRole('radio', { name: 'Prepare' }).getAttribute('aria-checked')).toBe('true')

    const prepare = screen.getByRole('radio', { name: 'Prepare' })
    fireEvent.keyDown(prepare, { key: 'Home' })
    expect(screen.getByRole('radio', { name: 'Explore' }).getAttribute('aria-checked')).toBe('true')
  })

  it('ignores unrelated keys', () => {
    render(<Harness />)
    const explore = screen.getByRole('radio', { name: 'Explore' })
    explore.focus()
    fireEvent.keyDown(explore, { key: 'Tab' })
    expect(explore.getAttribute('aria-checked')).toBe('true')
  })

  it('adapts the purpose line to the active task', () => {
    render(<Harness initial="check" />)
    expect(screen.getByTestId('task-purpose').textContent).toBe(
      'Find quality issues or explain differences between two versions.',
    )
  })
})

describe('TaskNav — section reachability', () => {
  it('renders one section link group per task plus the workspace anchors', () => {
    render(<Harness />)
    expect(
      Array.from(screen.getByTestId('section-nav-group-explore').querySelectorAll('a')).map(
        (link) => link.getAttribute('data-testid'),
      ),
    ).toEqual([
      'section-nav-schema',
      'section-nav-filters',
      'section-nav-sql',
      'section-nav-profile',
    ])
    expect(
      Array.from(screen.getByTestId('section-nav-group-check').querySelectorAll('a')).map((link) =>
        link.getAttribute('data-testid'),
      ),
    ).toEqual(['section-nav-validation', 'section-nav-compare'])
    expect(
      Array.from(screen.getByTestId('section-nav-group-change').querySelectorAll('a')).map((link) =>
        link.getAttribute('data-testid'),
      ),
    ).toEqual(['section-nav-editing', 'section-nav-history', 'section-nav-export'])
    expect(
      Array.from(screen.getByTestId('section-nav-group-prepare').querySelectorAll('a')).map(
        (link) => link.getAttribute('data-testid'),
      ),
    ).toEqual(['section-nav-pipeline'])
    expect(
      Array.from(screen.getByTestId('section-nav-group-workspace').querySelectorAll('a')).map(
        (link) => link.getAttribute('data-testid'),
      ),
    ).toEqual(['section-nav-grid', 'section-nav-record'])
  })

  it('marks the active task group with data-active and keeps every group exposed', () => {
    render(<Harness initial="check" />)
    expect(screen.getByTestId('section-nav-group-explore').getAttribute('data-active')).toBe(
      'false',
    )
    expect(screen.getByTestId('section-nav-group-check').getAttribute('data-active')).toBe('true')
    // Conditional exposure is a deferred slice: every group stays in the DOM
    // and exposed, and `data-active` is a marker only.
    for (const task of ['explore', 'check', 'change', 'prepare'] as const) {
      expect(screen.getByTestId(`section-nav-group-${task}`)).toBeTruthy()
    }
  })

  it('reveals a section through its link without intercepting the anchor', () => {
    const onReveal = vi.fn()
    render(<Harness onReveal={onReveal} />)
    const link = screen.getByTestId('section-nav-sql')
    expect(link.getAttribute('href')).toBe('#section-sql')
    link.click()
    expect(onReveal).toHaveBeenCalledWith('sql')
  })

  it('reveals the workspace sections through their anchors', () => {
    const onReveal = vi.fn()
    render(<Harness onReveal={onReveal} />)
    screen.getByTestId('section-nav-grid').click()
    expect(onReveal).toHaveBeenCalledWith('grid')
    screen.getByTestId('section-nav-record').click()
    expect(onReveal).toHaveBeenCalledWith('record')
  })

  it('describes each section link with that section purpose', () => {
    render(<Harness />)
    expect(screen.getByTestId('section-nav-schema').getAttribute('aria-describedby')).toBe(
      'section-schema-purpose',
    )
  })
})
