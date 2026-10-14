// SPDX-License-Identifier: AGPL-3.0-or-later

/** Session-only edit/history coordinator for the desktop dataset surface. */
import type { CellValue, EditOp, OverlayBase, TransformationHistory } from '@assay/domain'
import { appendOp, emptyHistory, insertRowId, redo, stateAtCursor, undo } from '@assay/domain'
import type { RowId } from '@assay/domain'

export interface EditControllerEffects {
  /** Validate a candidate effective view without publishing it to the grid. */
  preflight(history: TransformationHistory): Promise<void>
  /** Publish one validated history to the live provider and refresh its view. */
  activate(history: TransformationHistory): Promise<void>
}

export interface EditControllerSnapshot {
  readonly history: TransformationHistory
  readonly busy: boolean
  readonly error: string | null
  readonly revision: number
}

/**
 * Serializes candidate checks and history transitions. A candidate is never
 * made visible until preflight succeeds; a failed activation is rolled back
 * to the prior history. Disposal fences any queued or late completion.
 */
export class EditController {
  private history = emptyHistory()
  private queue: Promise<void> = Promise.resolve()
  private generation = 0
  private disposed = false
  private busy = false
  private error: string | null = null
  private revision = 0

  constructor(
    private readonly base: OverlayBase,
    private readonly effects: EditControllerEffects,
    private readonly changed: (snapshot: EditControllerSnapshot) => void = () => undefined,
  ) {}

  get snapshot(): EditControllerSnapshot {
    return {
      history: this.history,
      busy: this.busy,
      error: this.error,
      revision: this.revision,
    }
  }

  get currentHistory(): TransformationHistory {
    return this.history
  }

  commitCell(rowId: RowId, column: string, value: CellValue): Promise<void> {
    return this.apply({ kind: 'cell-set', rowId, column, value })
  }

  deleteRow(rowId: RowId): Promise<void> {
    return this.apply({ kind: 'row-delete', rowId })
  }

  insertRow(): Promise<void> {
    return this.apply((history) => {
      const state = stateAtCursor(this.base, history)
      const rowId = insertRowId(this.base.overlayAnchor, state.nextInsertSeq)
      return { kind: 'row-insert', rowId, position: { kind: 'end' }, values: new Map() }
    })
  }

  undo(): Promise<void> {
    return this.transitionAtExecution(undo)
  }

  redo(): Promise<void> {
    return this.transitionAtExecution(redo)
  }

  dispose(): void {
    this.disposed = true
    this.generation++
  }

  private apply(opOrFactory: EditOp | ((history: TransformationHistory) => EditOp)): Promise<void> {
    const generation = this.generation
    return this.enqueue(async () => {
      if (!this.isCurrent(generation)) return
      const previous = this.history
      const op = typeof opOrFactory === 'function' ? opOrFactory(previous) : opOrFactory
      const result = appendOp(this.base, previous, op)
      if (result.entry === null) {
        this.error = outcomeMessage(result.outcome)
        this.publish()
        return
      }
      await this.commitCandidate(previous, result.history, generation)
      if (this.isCurrent(generation)) {
        this.error = result.outcome.status === 'no-op' ? outcomeMessage(result.outcome) : this.error
        this.publish()
      }
    })
  }

  private transitionAtExecution(stepHistory: typeof undo): Promise<void> {
    const generation = this.generation
    return this.enqueue(async () => {
      if (!this.isCurrent(generation)) return
      const previous = this.history
      const step = stepHistory(previous)
      if (step.entry === null) return
      await this.commitCandidate(previous, step.history, generation)
    })
  }

  private async commitCandidate(
    previous: TransformationHistory,
    next: TransformationHistory,
    generation: number,
  ): Promise<void> {
    this.busy = true
    this.error = null
    this.publish()
    let activationStarted = false
    try {
      await this.effects.preflight(next)
      if (!this.isCurrent(generation)) return
      activationStarted = true
      await this.effects.activate(next)
      if (!this.isCurrent(generation)) return
      this.history = next
      this.revision++
    } catch (error) {
      if (!this.isCurrent(generation)) return
      this.error = engineMessage(error)
      if (activationStarted) {
        try {
          await this.effects.activate(previous)
        } catch {
          this.error += ' The previous view could not be restored.'
        }
      }
    } finally {
      if (this.isCurrent(generation)) {
        this.busy = false
        this.publish()
      }
    }
  }

  private enqueue(run: () => Promise<void>): Promise<void> {
    const task = this.queue.then(run, run)
    this.queue = task.then(
      () => undefined,
      () => undefined,
    )
    return task
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && this.generation === generation
  }

  private publish(): void {
    this.changed(this.snapshot)
  }
}

function outcomeMessage(outcome: ReturnType<typeof appendOp>['outcome']): string {
  return outcome.status === 'conflict'
    ? `Cannot apply edit: ${outcome.reason}.`
    : outcome.status === 'no-op'
      ? `No change: ${outcome.reason}.`
      : ''
}

/** Engine messages may contain SQL/value context; expose only the first line. */
function engineMessage(error: unknown): string {
  const summary = (error instanceof Error ? error.message : String(error)).split('\n')[0]?.trim()
  return `The engine rejected this edit: ${summary || 'the effective view could not be materialized'}. The previous view is unchanged.`
}
