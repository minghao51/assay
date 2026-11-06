// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Workbench task navigation (UI-RD-01 / rd-3).
 *
 * The twelve sections become four user goals. Membership is navigation only:
 * a task is not a dataset, a session or an execution scope — switching tasks
 * must never touch the engine, the overlay/history, a draft or a request.
 *
 * The section ids, titles and R-14 purpose subtitles are the values the shell
 * has always rendered; they move here so the containment rule can be asserted
 * in one pure place instead of being re-typed in the pane and in tests.
 *
 * Task framing is presentation-only: the pane's `data-task` attribute marks
 * the active task's sections (CSS), and choosing a task opens its manageable
 * sections. Conditional hiding of inactive tasks is a deferred reviewed slice,
 * so every section stays reachable today. Sections are always mounted — the
 * shell only ever hides a body (`hidden={!open}`), so a task switch cannot
 * remount a panel or drop its local state.
 */

/** The twelve sections the shell renders. Order is the current DOM order. */
export const WORKBENCH_SECTION_IDS = [
  'schema',
  'editing',
  'export',
  'history',
  'validation',
  'compare',
  'filters',
  'sql',
  'profile',
  'pipeline',
  'grid',
  'record',
] as const

export type WorkbenchSectionId = (typeof WORKBENCH_SECTION_IDS)[number]

/** The four user goals. Order is the task reading order; `prepare` stays last (q-15). */
export const WORKBENCH_TASK_IDS = ['explore', 'check', 'change', 'prepare'] as const

export type WorkbenchTaskId = (typeof WORKBENCH_TASK_IDS)[number]

/** Sections that belong to a task. Grid and Record are the workspace, never tasks. */
export const WORKSPACE_SECTION_IDS = ['grid', 'record'] as const

export type WorkspaceSectionId = (typeof WORKSPACE_SECTION_IDS)[number]

export interface WorkbenchSectionDef {
  readonly id: WorkbenchSectionId
  readonly title: string
}

export interface WorkbenchTaskDef {
  readonly id: WorkbenchTaskId
  readonly name: string
  /** One-line goal shown under the task switcher (approved UI-RD-01 copy). */
  readonly purpose: string
  /** Tool sections in this task, in the pane's existing relative order. */
  readonly sections: readonly WorkbenchSectionId[]
}

/**
 * Titles are unchanged from the previous shell (ug-13/R-14); only the grouping
 * is new. `record` and `grid` are workspace entries and are deliberately not
 * members of any task.
 */
export const WORKBENCH_SECTIONS: readonly WorkbenchSectionDef[] = [
  { id: 'schema', title: 'Schema' },
  { id: 'editing', title: 'Editing' },
  { id: 'export', title: 'Export' },
  { id: 'history', title: 'History' },
  { id: 'validation', title: 'Validation' },
  { id: 'compare', title: 'Compare' },
  { id: 'filters', title: 'Filters' },
  { id: 'sql', title: 'SQL' },
  { id: 'profile', title: 'Profile' },
  { id: 'pipeline', title: 'Pipeline' },
  { id: 'grid', title: 'Grid' },
  { id: 'record', title: 'Record' },
]

/**
 * R-14 purpose subtitles, byte-exact. They stay the toggle's description and
 * the section link's description, as before; grouping never renames a section.
 */
export const WORKBENCH_SECTION_PURPOSES: Readonly<Record<WorkbenchSectionId, string>> = {
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
}

/**
 * Membership. Within each task the order matches the pane's relative order
 * (the one deliberate exception is `history` before `export` inside Change:
 * review staged operations before delivering a copy).
 */
export const WORKBENCH_TASKS: readonly WorkbenchTaskDef[] = [
  {
    id: 'explore',
    name: 'Explore',
    purpose: 'Understand what is in the file: fields, filters, query and statistics.',
    sections: ['schema', 'filters', 'sql', 'profile'],
  },
  {
    id: 'check',
    name: 'Check',
    purpose: 'Find quality issues or explain differences between two versions.',
    sections: ['validation', 'compare'],
  },
  {
    id: 'change',
    name: 'Change',
    purpose: 'Make a reversible repair, review staged operations and deliver a copy.',
    sections: ['editing', 'history', 'export'],
  },
  {
    id: 'prepare',
    name: 'Prepare',
    purpose: 'Run deterministic steps and inspect gate and delivery evidence.',
    sections: ['pipeline'],
  },
]

/** The default task when a dataset session starts. */
export const DEFAULT_WORKBENCH_TASK: WorkbenchTaskId = 'explore'

const TASK_BY_SECTION: Readonly<Record<WorkbenchSectionId, WorkbenchTaskId | null>> = {
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
  grid: null,
  record: null,
}

/** The task that owns a tool section; `null` for the workspace (Grid/Record). */
export function taskOfSection(id: WorkbenchSectionId): WorkbenchTaskId | null {
  return TASK_BY_SECTION[id]
}

/** The tasks's sections in membership order. */
export function sectionsForTask(task: WorkbenchTaskId): readonly WorkbenchSectionId[] {
  return WORKBENCH_TASKS.find((entry) => entry.id === task)?.sections ?? []
}

/** Convenience for the pane: the task's display name. */
export function taskName(task: WorkbenchTaskId): string {
  return WORKBENCH_TASKS.find((entry) => entry.id === task)?.name ?? task
}
