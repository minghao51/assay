// SPDX-License-Identifier: AGPL-3.0-or-later

import type { NextAction } from './next-action'

/**
 * The dataset/session context bar (rd-3/rd-4).
 *
 * One line beside the grid: neutral facts about the **current dataset view**
 * plus exactly one next action derived by `deriveNextAction`. It deliberately
 * shows **no filename** (the shell exposes only table id/counts; ADR 0025
 * discipline) and **no copied verdict count** (the verdict and the existing
 * section summary keep the numbers).
 *
 * Only the state sentence is a polite status region; the action is a normal
 * button, so assistive technology is not asked to treat a control as a live
 * announcement. Nothing here runs on its own.
 */

export interface DatasetContextBarProps {
  readonly rows: number
  readonly columns: number
  readonly stagedOperations: number
  readonly next: NextAction
  readonly onAction: () => void
  readonly onSecondaryReview: () => void
  /** True after a validation/diff "Show row" jump, until the user returns. */
  readonly jumpOrigin: boolean
  readonly onBackToFindings: () => void
}

function stagedCopy(count: number): string {
  if (count === 0) return 'No staged operations'
  return count === 1 ? '1 staged operation' : `${String(count)} staged operations`
}

export function DatasetContextBar({
  rows,
  columns,
  stagedOperations,
  next,
  onAction,
  onSecondaryReview,
  jumpOrigin,
  onBackToFindings,
}: DatasetContextBarProps) {
  return (
    <div className="workbench-context" data-testid="dataset-context" aria-label="Dataset context">
      <div className="workbench-context-facts">
        <span className="workbench-context-label">Current dataset view</span>
        <span className="workbench-context-sep" aria-hidden="true">
          ·
        </span>
        <span data-testid="context-rows">
          {rows} {rows === 1 ? 'row' : 'rows'} × {columns} {columns === 1 ? 'column' : 'columns'}
        </span>
        <span className="workbench-context-sep" aria-hidden="true">
          ·
        </span>
        <span data-testid="context-staged">{stagedCopy(stagedOperations)}</span>
        {jumpOrigin && (
          <button
            type="button"
            className="workbench-context-chip"
            data-testid="context-back-to-findings"
            onClick={onBackToFindings}
          >
            Back to findings
          </button>
        )}
      </div>
      <div className="workbench-context-action">
        <span
          className="workbench-context-state"
          data-tone={next.tone}
          data-testid="context-state"
          role="status"
        >
          {next.state}
        </span>
        {next.action !== null && (
          <button
            type="button"
            className="workbench-context-primary"
            data-testid="context-action"
            data-action={next.kind}
            onClick={onAction}
          >
            {next.action}
          </button>
        )}
        {next.secondaryReview && (
          <button
            type="button"
            className="workbench-context-link"
            data-testid="context-review"
            onClick={onSecondaryReview}
          >
            Review findings
          </button>
        )}
      </div>
    </div>
  )
}
