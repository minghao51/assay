// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useId } from 'react'
import type { KeyboardEvent } from 'react'
import {
  WORKBENCH_SECTIONS,
  WORKBENCH_TASKS,
  sectionsForTask,
  taskName,
  type WorkbenchSectionId,
  type WorkbenchTaskId,
} from './tasks'

/**
 * Task navigation (UI-RD-01).
 *
 * Semantics: a single-select **radio group**. There is no tabpanel element in
 * the shell, so labelling this as tabs would promise behaviour that does not
 * exist (the review's RD-R05 rule). Arrow keys move and select (automatic
 * activation); Home/End jump. Mouse selection never moves focus into content.
 *
 * The section links keep the shell's existing `section-nav-<id>` contract:
 * every section keeps one link, so `closeSection` still returns focus to the
 * same link it always did (R-07). All four groups are rendered and exposed in
 * this slice; the active group carries `data-active="true"` as a marker.
 * Conditional exposure of inactive groups is deferred to its own reviewed
 * slice (UI-RD-01 amendment), so no group is hidden today.
 */

export interface TaskNavProps {
  readonly activeTask: WorkbenchTaskId
  readonly onSelectTask: (task: WorkbenchTaskId) => void
  /** Reveal a section: activates its task, expands it and follows the anchor. */
  readonly onRevealSection: (id: WorkbenchSectionId) => void
}

function sectionTitle(id: WorkbenchSectionId): string {
  return WORKBENCH_SECTIONS.find((section) => section.id === id)?.title ?? id
}

export function TaskNav({ activeTask, onSelectTask, onRevealSection }: TaskNavProps) {
  const purposeId = useId()
  const activeTaskDef = WORKBENCH_TASKS.find((task) => task.id === activeTask)

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement
      if (target.getAttribute('role') !== 'radio') return
      const index = WORKBENCH_TASKS.findIndex((task) => task.id === activeTask)
      let nextIndex: number | null = null
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        nextIndex = (index + 1) % WORKBENCH_TASKS.length
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        nextIndex = (index - 1 + WORKBENCH_TASKS.length) % WORKBENCH_TASKS.length
      } else if (event.key === 'Home') {
        nextIndex = 0
      } else if (event.key === 'End') {
        nextIndex = WORKBENCH_TASKS.length - 1
      }
      if (nextIndex === null) return
      event.preventDefault()
      const next = WORKBENCH_TASKS[nextIndex]
      if (next === undefined) return
      onSelectTask(next.id)
      document.getElementById(`task-${next.id}`)?.focus()
    },
    [activeTask, onSelectTask],
  )

  return (
    <div className="workbench-task-nav" data-testid="task-nav">
      <div
        className="workbench-task-tabs"
        role="radiogroup"
        aria-label="Workbench task"
        aria-describedby={purposeId}
        onKeyDown={handleKeyDown}
      >
        {WORKBENCH_TASKS.map((task) => {
          const selected = task.id === activeTask
          return (
            <button
              key={task.id}
              type="button"
              role="radio"
              id={`task-${task.id}`}
              data-testid={`task-${task.id}`}
              data-task-choice={task.id}
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              className="workbench-task-choice"
              onClick={() => {
                onSelectTask(task.id)
              }}
            >
              {task.name}
            </button>
          )
        })}
      </div>
      <p className="workbench-task-purpose" id={purposeId} data-testid="task-purpose">
        {activeTaskDef?.purpose ?? ''}
      </p>
      <nav className="workbench-nav" aria-label="Workbench sections" data-testid="section-nav">
        {WORKBENCH_TASKS.map((task) => (
          <ul
            key={task.id}
            className="workbench-nav-list workbench-nav-group"
            data-testid={`section-nav-group-${task.id}`}
            data-active={task.id === activeTask ? 'true' : 'false'}
            aria-label={`${taskName(task.id)} sections`}
          >
            {sectionsForTask(task.id).map((id) => (
              <li key={id}>
                <a
                  className="workbench-nav-link"
                  href={`#section-${id}`}
                  data-testid={`section-nav-${id}`}
                  aria-describedby={`section-${id}-purpose`}
                  onClick={() => {
                    onRevealSection(id)
                  }}
                >
                  {sectionTitle(id)}
                </a>
              </li>
            ))}
          </ul>
        ))}
        <ul
          className="workbench-nav-list workbench-nav-group"
          data-testid="section-nav-group-workspace"
          data-active="true"
          aria-label="Workspace"
        >
          <li>
            <a
              className="workbench-nav-link"
              href="#section-grid"
              data-testid="section-nav-grid"
              onClick={() => {
                onRevealSection('grid')
              }}
            >
              Grid
            </a>
          </li>
          <li>
            <a
              className="workbench-nav-link"
              href="#section-record"
              data-testid="section-nav-record"
              onClick={() => {
                onRevealSection('record')
              }}
            >
              Record
            </a>
          </li>
        </ul>
      </nav>
    </div>
  )
}
