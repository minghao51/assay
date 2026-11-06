// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EngineTableHandle } from '@assay/engine-duckdb'
import { App } from './App'
import type { ArrowTableLike } from './grid/provider'

/**
 * rd-3b — conditional task visibility: the structural pins.
 *
 * CONDITIONAL EXPOSURE IS CSS. The environment this file runs in (happy-dom)
 * applies NO stylesheet to the rendered tree, so nothing here can prove that a
 * section is really hidden — `getComputedStyle` has no `@media` rules to
 * resolve. The authoritative exposure proof is the real-browser matrix in
 * `tests/e2e/workbench-visibility.spec.ts` (computed `display` per task at
 * 1024×700 and 1440×900, the mounted-panel/state-survival case, the focus
 * guard, and the 900px unfiltered contract). Those cheap structural pins below
 * cover the three things a browser run would only catch late:
 *
 * 1. **The rule shape.** Exactly two `display: none` rules, both inside the
 *    existing `@media (min-width: 1024px)` block: the section rule keyed on
 *    `.workbench-tools[data-task='<task>']` + `.workbench-section[data-task]`
 *    with `:not([data-task='<task>'])`, and the nav rule keyed on
 *    `.workbench-nav-group[data-active='false']`. No section is hidden by any
 *    rule outside that block (so the narrow stack is untouched), and no other
 *    hiding mechanism (`[hidden]` on a section, `visibility`, `opacity`,
 *    `height: 0`) is introduced.
 * 2. **The attributes the rules depend on.** The pane carries exactly one
 *    valid `data-task`; the ten tool sections each carry the one that owns
 *    them; Grid and Record carry NO `data-task` (they are the workspace, and
 *    the `:not()` rule must never be able to catch them).
 * 3. **Mounting.** All twelve sections stay in the DOM for every task — the
 *    whole reason the CSS-only mechanism is safe: no React unmount, no re-key,
 *    so panel-local state (SQL draft, filters, record target) survives.
 *
 * Comment text is stripped before any CSS assertion, so prose can never satisfy
 * a pin.
 */

const STYLESHEET = readFileSync(resolve(process.cwd(), 'apps', 'web', 'src', 'index.css'), 'utf8')

/** Stylesheet with comments removed (prose must never satisfy a pin). */
const CSS = STYLESHEET.replace(/\/\*[\s\S]*?\*\//g, '')

/** The `@media (min-width: 1024px)` block — the only place exposure may live. */
function desktopBlock(css: string): string {
  const prelude = '@media (min-width: 1024px)'
  const start = css.indexOf(prelude)
  if (start < 0) throw new Error(`missing at-rule: ${prelude}`)
  const next = css.indexOf('@media', start + prelude.length)
  return css.slice(start, next < 0 ? css.length : next)
}

const DESKTOP = desktopBlock(CSS)

/** The stylesheet with the desktop block removed (the <1024px + base sheet). */
const NON_DESKTOP = CSS.replace(DESKTOP, '')

/** Collapse whitespace so a re-wrap cannot break a structural pin. */
function flat(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

const TASKS = ['explore', 'check', 'change', 'prepare'] as const

/** Section id → the task that owns it (`taskOfSection` in workbench/tasks.ts). */
const SECTION_TASK: Readonly<Record<string, (typeof TASKS)[number]>> = {
  schema: 'explore',
  filters: 'explore',
  sql: 'explore',
  profile: 'explore',
  validation: 'check',
  compare: 'check',
  editing: 'change',
  history: 'change',
  export: 'change',
  pipeline: 'prepare',
}

/** The twelve sections in DOM order. */
const SECTION_IDS = [
  'schema',
  'editing',
  'history',
  'export',
  'validation',
  'compare',
  'filters',
  'sql',
  'profile',
  'pipeline',
  'grid',
  'record',
] as const

/** Rule selectors that target a `.workbench-section` element (not its body). */
const SECTION_SELECTOR = /\.workbench-section(?![-a-z])/

describe('rd-3b — the exposure rules live only in the ≥1024px block', () => {
  it('hides the sections outside the active task with one data-task-scoped rule', () => {
    const desktop = flat(DESKTOP)
    for (const task of TASKS) {
      expect(
        desktop,
        `the §2.1 selector for ${task}: pane data-task + section data-task + :not()`,
      ).toContain(
        `.workbench-tools[data-task='${task}'] .workbench-section[data-task]:not([data-task='${task}'])`,
      )
    }
    // One declaration body for the whole four-selector list.
    expect(desktop).toMatch(
      /\.workbench-section\[data-task\]:not\(\[data-task='prepare'\]\)\s*\{\s*display:\s*none;/,
    )
  })

  it('hides the inactive nav groups, and never the workspace group', () => {
    expect(flat(DESKTOP)).toMatch(
      /\.workbench-nav-group\[data-active='false'\]\s*\{\s*display:\s*none;/,
    )
    // The workspace group is hard-coded `data-active="true"` in TaskNav, so the
    // rule can never hide it; no task-group id is named in CSS.
    expect(DESKTOP).not.toMatch(/workbench-nav-group-workspace/)
    for (const task of TASKS) {
      expect(DESKTOP).not.toContain(`section-nav-group-${task}`)
    }
  })

  it('declares no section-hiding rule outside the ≥1024px block', () => {
    // Every flat rule in the non-desktop sheet that targets a `.workbench-section`
    // element: none of them may remove it from the layout.
    const ruleRe = /([^{}]+)\{([^{}]*)\}/g
    const offenders: string[] = []
    let match: RegExpExecArray | null
    while ((match = ruleRe.exec(NON_DESKTOP)) !== null) {
      const selectorText = match[1]?.trim() ?? ''
      if (selectorText.startsWith('@')) continue
      const body = match[2] ?? ''
      const targetsSection = selectorText
        .split(',')
        .some((selector) => SECTION_SELECTOR.test(selector.replace(/\[[^\]]*\]/g, '')))
      if (targetsSection && /display:\s*none/.test(body)) offenders.push(selectorText)
    }
    expect(offenders, 'no `.workbench-section { display: none }` below 1024px').toEqual([])
  })

  it('uses no other hiding mechanism for sections (no hidden attribute, visibility, opacity)', () => {
    // `[hidden]` remains the COLLAPSE attribute of a section BODY; the section
    // element itself must never be hidden by attribute, and no ghost-leaving
    // mechanism is used anywhere for the task filter.
    expect(CSS).not.toMatch(/\.workbench-section\s*\{[^}]*visibility:\s*hidden/)
    expect(CSS).not.toMatch(/\.workbench-section\s*\{[^}]*opacity:\s*0/)
    expect(CSS).not.toMatch(/\.workbench-section\[hidden\]/)
    expect(CSS).not.toMatch(/\.workbench-section\s*\{[^}]*height:\s*0/)
    // Exactly one breakpoint decides exposure (no second media query).
    expect(CSS.match(/\.workbench-section\[data-task\]:not/g) ?? []).toHaveLength(4)
  })
})

/* ---- The attributes those rules key on, driven through the real App ---- */

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

vi.mock('@assay/data-sources/browser', () => ({
  pickDataFile: async (): Promise<{ source: { getFile: () => Promise<File> } }> => ({
    source: { getFile: async () => new File(['id\n1\n'], 'visibility.jsonl') },
  }),
}))

vi.mock('./lib/engine', () => ({
  engineClient: {
    open: async () => FAKE_HANDLE,
    schema: async () => FAKE_SCHEMA,
    rowCount: async () => 1,
    fetchRange: async () => ({ batch: fakeBatch(), hasMore: false }),
  },
}))

afterEach(cleanup)

/** Render the real App and open a dataset (picker + engine faked). */
async function open(): Promise<void> {
  render(createElement(App))
  await act(async () => {
    fireEvent.click(screen.getByTestId('open-button'))
  })
  await screen.findByTestId('schema-section')
  await screen.findByTestId('sql-panel')
}

function taskValue(element: Element | null): string | null {
  return element === null ? null : element.getAttribute('data-task')
}

describe('rd-3b — the data-task wiring the CSS rules depend on', () => {
  it('puts exactly one valid data-task on the pane and none on Grid/Record', async () => {
    await open()

    const pane = document.querySelector('.workbench-tools')
    expect(pane).not.toBeNull()
    const paneValue = taskValue(pane)
    expect(TASKS).toContain(paneValue)
    // Exactly one attribute value: the pane is the single switch the CSS reads.
    expect(Array.from(pane?.attributes ?? []).filter((a) => a.name === 'data-task')).toHaveLength(1)

    // Every tool section carries the one task that owns it.
    for (const [id, task] of Object.entries(SECTION_TASK)) {
      expect(taskValue(document.getElementById(`section-${id}`)), id).toBe(task)
    }
    // Grid and Record are the workspace: no data-task, so the `:not()` rule
    // cannot reach them.
    expect(taskValue(document.getElementById('section-grid'))).toBeNull()
    expect(taskValue(document.getElementById('section-record'))).toBeNull()
    expect(document.querySelectorAll('.workbench-section[data-task]')).toHaveLength(10)
  })

  it('keeps all twelve sections mounted for every task, with the pane switched', async () => {
    await open()
    const before = Array.from(document.querySelectorAll('.workbench-section'))

    for (const task of TASKS) {
      await act(async () => {
        fireEvent.click(screen.getByTestId(`task-${task}`))
      })
      expect(taskValue(document.querySelector('.workbench-tools'))).toBe(task)
      // Same twelve sections, same nodes: nothing is unmounted or re-keyed by
      // the switch (the state-preservation guarantee the CSS-only filter buys).
      const after = Array.from(document.querySelectorAll('.workbench-section'))
      expect(after.map((section) => section.getAttribute('data-section'))).toEqual([...SECTION_IDS])
      for (const [index, section] of after.entries()) {
        expect(
          section.isSameNode(before[index] ?? null),
          `section ${String(index)} remounted`,
        ).toBe(true)
      }

      // Exactly the active task's sections match the pane's value.
      const exposed = after
        .filter((section) => taskValue(section) === task)
        .map((section) => section.getAttribute('data-section'))
      expect(exposed).toEqual(
        Object.entries(SECTION_TASK)
          .filter(([, owner]) => owner === task)
          .map(([id]) => id)
          .sort((a, b) => SECTION_IDS.indexOf(a as 'schema') - SECTION_IDS.indexOf(b as 'schema')),
      )
    }
  })

  it('marks exactly one task group plus Workspace as active', async () => {
    await open()

    for (const task of TASKS) {
      await act(async () => {
        fireEvent.click(screen.getByTestId(`task-${task}`))
      })
      const groups = Array.from(document.querySelectorAll('.workbench-nav-group'))
      expect(groups).toHaveLength(5)
      const active = groups
        .filter((group) => group.getAttribute('data-active') === 'true')
        .map((group) => group.getAttribute('data-testid'))
      expect(active).toEqual([`section-nav-group-${task}`, 'section-nav-group-workspace'])
      // The four task groups stay in the DOM; CSS (not rendering) hides them.
      expect(document.querySelectorAll('.workbench-nav-group a')).toHaveLength(12)
    }
  })
})
