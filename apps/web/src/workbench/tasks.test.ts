// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WORKBENCH_TASK,
  WORKBENCH_SECTIONS,
  WORKBENCH_SECTION_IDS,
  WORKBENCH_SECTION_PURPOSES,
  WORKBENCH_TASKS,
  WORKSPACE_SECTION_IDS,
  sectionsForTask,
  taskName,
  taskOfSection,
} from './tasks'

describe('UI-RD-01 task membership', () => {
  it('keeps the four tasks in the reading order with Prepare last', () => {
    expect(WORKBENCH_TASKS.map((task) => task.id)).toEqual([
      'explore',
      'check',
      'change',
      'prepare',
    ])
    expect(WORKBENCH_TASKS[WORKBENCH_TASKS.length - 1]?.sections).toEqual(['pipeline'])
  })

  it('partitions every tool section exactly once', () => {
    const assigned = WORKBENCH_TASKS.flatMap((task) => task.sections)
    const toolSections = WORKBENCH_SECTION_IDS.filter(
      (id) => !(WORKSPACE_SECTION_IDS as readonly string[]).includes(id),
    )
    expect(assigned).toHaveLength(toolSections.length)
    expect(new Set(assigned).size).toBe(assigned.length)
    expect([...assigned].sort()).toEqual([...toolSections].sort())
  })

  it('never makes Grid or Record a task section', () => {
    for (const id of WORKSPACE_SECTION_IDS) {
      expect(taskOfSection(id)).toBeNull()
      expect(WORKBENCH_TASKS.some((task) => task.sections.includes(id))).toBe(false)
    }
  })

  it('maps each task section back to its owning task', () => {
    for (const task of WORKBENCH_TASKS) {
      expect(sectionsForTask(task.id)).toEqual(task.sections)
      for (const id of task.sections) expect(taskOfSection(id)).toBe(task.id)
    }
  })

  it('keeps every section title and R-14 purpose byte-exact', () => {
    expect(WORKBENCH_SECTIONS.map((section) => section.id)).toEqual([...WORKBENCH_SECTION_IDS])
    expect(Object.fromEntries(WORKBENCH_SECTIONS.map((s) => [s.id, s.title]))).toEqual({
      schema: 'Schema',
      editing: 'Editing',
      export: 'Export',
      history: 'History',
      validation: 'Validation',
      compare: 'Compare',
      filters: 'Filters',
      sql: 'SQL',
      profile: 'Profile',
      pipeline: 'Pipeline',
      grid: 'Grid',
      record: 'Record',
    })
    expect(WORKBENCH_SECTION_PURPOSES).toEqual({
      schema: 'Fields and types',
      grid: 'Browse the rows',
      filters: 'Show only matching rows',
      validation: 'Check data against rules',
      compare: 'Diff two datasets by key',
      sql: 'Query with DuckDB SQL',
      editing: 'Stage edits in this session',
      history: 'Review and undo staged edits',
      export: 'Write a reviewed copy',
      record: 'Inspect one row in full',
      profile: 'Column statistics summary',
      pipeline: 'Chained contract checks',
    })
  })

  it('exposes a display name for every task', () => {
    expect(WORKBENCH_TASKS.map((task) => taskName(task.id))).toEqual([
      'Explore',
      'Check',
      'Change',
      'Prepare',
    ])
  })

  it('defaults to Explore', () => {
    expect(DEFAULT_WORKBENCH_TASK).toBe('explore')
  })

  it('keeps the Explore and Change journey order', () => {
    expect(sectionsForTask('explore')).toEqual(['schema', 'filters', 'sql', 'profile'])
    // History precedes Export so staged operations are reviewed before delivery.
    expect(sectionsForTask('change')).toEqual(['editing', 'history', 'export'])
  })
})
