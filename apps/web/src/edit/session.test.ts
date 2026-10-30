// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import type { OverlayBase, TransformationHistory } from '@assay/domain'
import {
  appendOp,
  baseRowId,
  emptyHistory,
  foldOverlay,
  insertRowId,
  stateAtCursor,
  undo,
} from '@assay/domain'
import {
  activeOps,
  castRefusalMessage,
  classifyOpenFailure,
  commitWithRollback,
  editOutcomeMessage,
  engineErrorDetail,
  engineErrorLine,
  engineErrorMessage,
  engineRejectionMessage,
  openFailureMessage,
  overlaySnapshot,
} from './session'

const BASE: OverlayBase = {
  baseAnchor: 'fv-5-1000',
  overlayAnchor: 'ov-1',
  columns: [
    { name: 'id', type: 'BIGINT' },
    { name: 'label', type: 'VARCHAR' },
  ],
  baseRowCount: 2,
}

describe('activeOps / overlaySnapshot — the engine-facing history projection', () => {
  it('projects exactly the prefix left of the cursor, in order', () => {
    const first = appendOp(BASE, emptyHistory(), {
      kind: 'cell-set',
      rowId: baseRowId(BASE.baseAnchor, 0),
      column: 'label',
      value: { kind: 'string', value: 'a' },
    })
    const second = appendOp(BASE, first.history, {
      kind: 'cell-set',
      rowId: baseRowId(BASE.baseAnchor, 1),
      column: 'label',
      value: { kind: 'string', value: 'b' },
    })
    expect(activeOps(second.history)).toHaveLength(2)

    // Undoing is a cursor move: the engine-facing ops shrink with it.
    const undone = undo(second.history)
    expect(activeOps(undone.history)).toHaveLength(1)
    expect(overlaySnapshot(BASE, undone.history)).toEqual({
      base: BASE,
      ops: [
        {
          kind: 'cell-set',
          rowId: baseRowId(BASE.baseAnchor, 0),
          column: 'label',
          value: { kind: 'string', value: 'a' },
        },
      ],
    })
  })

  it('after undoing every entry the snapshot is empty and the fold equals the initial state', () => {
    const insertedId = insertRowId(BASE.overlayAnchor, 0)
    const appended = appendOp(BASE, emptyHistory(), {
      kind: 'row-insert',
      rowId: insertedId,
      position: { kind: 'end' },
      values: new Map(),
    })
    const undone = undo(appended.history)
    const snapshot = overlaySnapshot(BASE, undone.history)
    expect(snapshot.ops).toEqual([])
    // Undo→clean: the pure fold of the empty prefix carries no edits/inserts.
    const state = stateAtCursor(BASE, undone.history)
    expect(state.edits.size).toBe(0)
    expect(state.inserts.size).toBe(0)
    expect(state.deletedBase.size).toBe(0)
  })

  it('is a pass-through of the raw ops (m4-4): the engine folds inserted-row edits itself', () => {
    // m4-2b made the engine merge folded cell edits over insert values, so the
    // m4-3 web-side projection is gone. The snapshot must be exactly the active
    // ops, and folding them must still carry an edit on an inserted row — the
    // behavior the m4-3 insert e2e observes end to end.
    const insertedId = insertRowId(BASE.overlayAnchor, 0)
    let history: TransformationHistory = appendOp(BASE, emptyHistory(), {
      kind: 'row-insert',
      rowId: insertedId,
      position: { kind: 'end' },
      values: new Map(),
    }).history
    history = appendOp(BASE, history, {
      kind: 'cell-set',
      rowId: insertedId,
      column: 'label',
      value: { kind: 'string', value: 'edited' },
    }).history

    const snapshot = overlaySnapshot(BASE, history)
    expect(snapshot.ops).toEqual(activeOps(history))
    const state = foldOverlay(BASE, snapshot.ops ?? []).state
    expect(state.inserts.get(insertedId)?.live).toBe(true)
    expect(state.edits.get(insertedId)?.get('label')).toEqual({
      kind: 'string',
      value: 'edited',
    })
  })
})

describe('editOutcomeMessage — surface typed outcomes, never swallow', () => {
  it('returns null for an applied op', () => {
    expect(editOutcomeMessage({ status: 'applied', notes: [] })).toBeNull()
  })

  it('describes no-op and conflict outcomes in plain text', () => {
    expect(editOutcomeMessage({ status: 'no-op', reason: 'cell-value-unchanged' })).toContain(
      'already has that value',
    )
    expect(editOutcomeMessage({ status: 'conflict', reason: 'row-deleted' })).toContain(
      'was deleted',
    )
    expect(editOutcomeMessage({ status: 'conflict', reason: 'row-anchor-mismatch' })).toContain(
      'different file version',
    )
    // m4-4 column-op conflicts use the same surface.
    expect(editOutcomeMessage({ status: 'conflict', reason: 'rename-collision' })).toContain(
      'already exists',
    )
    expect(editOutcomeMessage({ status: 'no-op', reason: 'cast-identity' })).toContain(
      'already has that type',
    )
  })
})

describe('engineRejectionMessage — readable, text-only engine summary', () => {
  it('keeps only the engine summary line, never the composed SQL tail', () => {
    const message = engineRejectionMessage(
      new Error(
        'Conversion Error: invalid date field format: "not-a-date", expected format is (YYYY-MM-DD)\nLINE 1: SELECT CAST(...)',
      ),
    )
    expect(message).toContain('The engine rejected this edit:')
    expect(message).toContain('Conversion Error')
    expect(message).toContain('The previous view is unchanged.')
    expect(message).not.toContain('LINE 1')
  })

  it('handles non-Error rejections without throwing', () => {
    expect(engineRejectionMessage('boom')).toContain('boom')
  })

  it('translates the opaque mvp glue error into a readable summary', () => {
    const message = engineRejectionMessage(new Error('_setThrew is not defined'))
    expect(message).toBe(
      "The engine rejected this edit: the column's type rejected the value. The previous view is unchanged.",
    )
    expect(message).not.toContain('_setThrew')
  })

  it('q-8: renders the engine value-free materialization class, never a value fragment', () => {
    // The worker maps every overlay-materialization DuckDB error to this
    // class before posting (`OVERLAY_MATERIALIZATION_FAILURE` in
    // engine-executor). A real DuckDB message still reflects the composed SQL
    // on the lines below its summary, so `engineRejectionMessage` must keep
    // only the summary and drop the value/SQL fragment tail (ADR 0025).
    const message = engineRejectionMessage(
      new Error(
        'the edited view could not be materialized\n' +
          "LINE 1: SELECT CAST('not-a-date''; DROP TABLE x --' AS DATE)",
      ),
    )
    expect(message).toBe(
      'The engine rejected this edit: the edited view could not be materialized. ' +
        'The previous view is unchanged.',
    )
    expect(message).not.toContain("'; DROP TABLE x --")
    expect(message).not.toContain('SELECT')
  })
})

describe('engineErrorLine / engineErrorMessage — one single-line summary per surface (UG-30)', () => {
  /** A realistic multi-line engine diagnostic: summary + composed SQL tail. */
  const MULTILINE = new Error(
    'Binder Error: Referenced column "nope" not found in FROM clause!\n' +
      'LINE 1: SELECT nope FROM "assay_t1"\n               ^',
  )

  it('reduces the detail to its first line and keeps the full text for the disclosure', () => {
    expect(engineErrorLine(MULTILINE, 'fallback')).toBe(
      'Binder Error: Referenced column "nope" not found in FROM clause!',
    )
    // The raw multi-line text is still available — but only for a `<details>`
    // disclosure, never for a rendered alert message.
    expect(engineErrorDetail(MULTILINE)).toContain('LINE 1: SELECT nope')
  })

  it('strips every line-break shape, so no newline survives into a message', () => {
    for (const breakage of ['\r\n', '\r', '\n', '\u2028', '\u2029']) {
      const raw = `first line${breakage}second line`
      const line = engineErrorLine(raw, 'fallback')
      expect(line, `break ${JSON.stringify(breakage)}`).toBe('first line')
      expect(line).not.toMatch(/\r|\n|\u2028|\u2029/)
    }
  })

  it('falls back for an empty message and the opaque mvp glue error', () => {
    expect(engineErrorLine(new Error(''), 'the fallback')).toBe('the fallback')
    expect(engineErrorLine(new Error('_setThrew is not defined'), 'the fallback')).toBe(
      'the fallback',
    )
    expect(engineErrorLine(new Error('   \n  '), 'the fallback')).toBe('the fallback')
  })

  it('frames every operation with what failed and what did not change', () => {
    const summary = 'the engine rejected the request'
    expect(engineErrorMessage('open', summary)).toBe(
      'The file could not be opened. the engine rejected the request',
    )
    expect(engineErrorMessage('sql', summary)).toContain(
      'The query could not run: the engine rejected the request.',
    )
    expect(engineErrorMessage('sql', summary)).toContain(
      'The dataset and its staged changes are unchanged.',
    )
    expect(engineErrorMessage('profile', summary)).toContain(
      'The profile could not be computed: the engine rejected the request.',
    )
    expect(engineErrorMessage('profile', summary)).toContain(
      'The dataset and its staged changes are unchanged.',
    )
    expect(engineErrorMessage('filter', summary)).toContain(
      'The filter could not be applied: the engine rejected the request.',
    )
    expect(engineErrorMessage('filter', summary)).toContain(
      'The previous filters are still in effect.',
    )
    expect(engineErrorMessage('validation', summary)).toBe(
      'the engine rejected the request. The previous validation view is unchanged.',
    )
    expect(engineErrorMessage('diff', summary)).toBe(
      'the engine rejected the request. The previous comparison view is unchanged.',
    )
  })

  it('does not double a full stop the summary already carries', () => {
    expect(engineErrorMessage('sql', 'Enter a SQL query to run.')).toBe(
      'The query could not run: Enter a SQL query to run. ' +
        'The dataset and its staged changes are unchanged.',
    )
  })

  it('UG-25: the read-only validation/diff messages never contain the word "edit"', () => {
    for (const operation of ['validation', 'diff'] as const) {
      const message = engineErrorMessage(operation, MULTILINE)
      expect(message, operation).not.toContain('edit')
      expect(message, operation).not.toContain('Edit')
      expect(message, operation).not.toMatch(/\r|\n/)
      expect(message, operation).not.toContain('LINE 1')
    }
    // The edit-domain copy intentionally still says "edit" — the Ug-25 leak
    // was reusing it for read-only sessions, not the wording itself.
    expect(engineRejectionMessage(MULTILINE)).toContain('edit')
  })
})

describe('open-failure classification — a human cause, never the raw diagnostic (UG-5)', () => {
  it("classifies the engine's unsupported-format refusal", () => {
    const error = new Error(
      'unsupported dataset format: this engine reads .parquet, .csv, .jsonl and .json files',
    )
    expect(classifyOpenFailure(engineErrorDetail(error))).toBe('unsupported-format')
    expect(openFailureMessage(error)).toBe(
      'The file could not be opened. This file type is not supported — open a .parquet, .csv, .jsonl or .json file.',
    )
  })

  it('classifies a corrupt/truncated Parquet diagnostic', () => {
    const error = new Error(
      "Invalid Input Error: No magic bytes found at end of file 't1'\n" +
        'LINE 1: SELECT * FROM read_parquet(t1)',
    )
    expect(classifyOpenFailure(engineErrorDetail(error))).toBe('unreadable')
    const message = openFailureMessage(error)
    expect(message).toContain('could not be read')
    // The raw DuckDB diagnostic is not the human cause.
    expect(message).not.toContain('magic bytes')
    expect(message).not.toContain('read_parquet')
    expect(message).not.toMatch(/\r|\n/)
  })

  it('classifies the mvp glue error for a corrupt file as unreadable', () => {
    // Verified against the built app (2026-10-30): a Parquet file with no
    // valid footer surfaces through `open` as exactly this opaque emscripten
    // glue error, so the classifier must not fall back to the generic cause.
    const error = new Error('_setThrew is not defined')
    expect(classifyOpenFailure(engineErrorDetail(error))).toBe('unreadable')
    expect(openFailureMessage(error)).toContain('It may be corrupt, truncated')
    expect(openFailureMessage(error)).not.toContain('_setThrew')
  })

  it('falls back to the generic cause for an unrecognised failure', () => {
    expect(classifyOpenFailure('something unexpected')).toBe('unknown')
    expect(openFailureMessage(new Error('something unexpected'))).toBe(
      'The file could not be opened. The file could not be read. It may be unavailable, or its format may not match its name.',
    )
  })
})

describe('castRefusalMessage — readable, text-only refusal for a doomed cast', () => {
  it('names the column and target type and states that nothing was applied', () => {
    const message = castRefusalMessage('country', 'INTEGER')
    expect(message).toContain('"country"')
    expect(message).toContain('INTEGER')
    expect(message).toContain('cannot convert')
    expect(message).toContain('No cast was applied')
  })
})

describe('commitWithRollback — a rejected overlay restores the previous effective view', () => {
  const previous = emptyHistory()
  const next = appendOp(BASE, previous, {
    kind: 'cell-set',
    rowId: baseRowId(BASE.baseAnchor, 0),
    column: 'label',
    value: { kind: 'text', text: '2025-01-04' },
  }).history

  it('publishes the new history and returns no message when the engine accepts', async () => {
    const published: TransformationHistory[] = []
    let refreshes = 0
    const result = await commitWithRollback(previous, next, {
      setActive: (history) => published.push(history),
      refresh: async () => {
        refreshes += 1
      },
    })
    expect(result).toEqual({ message: null, restoreFailed: false })
    expect(published).toEqual([next])
    expect(refreshes).toBe(1)
  })

  it('rolls back to the previous history and re-materializes it after a rejection', async () => {
    const published: TransformationHistory[] = []
    let refreshes = 0
    const result = await commitWithRollback(previous, next, {
      setActive: (history) => published.push(history),
      refresh: async () => {
        refreshes += 1
        if (refreshes === 1) {
          throw new Error(
            'Conversion Error: invalid date field format: "not-a-date"\nLINE 1: SELECT CAST(...)',
          )
        }
      },
    })
    // The failed overlay was published, then the previous one restored and
    // re-materialized: setActive(next) → setActive(previous) → refresh twice.
    expect(published).toEqual([next, previous])
    expect(refreshes).toBe(2)
    expect(result.message).toContain('Conversion Error')
    expect(result.message).not.toContain('LINE 1')
    expect(result.restoreFailed).toBe(false)
  })

  it('rolls back when the refresh window read rejects (value-level cast class)', async () => {
    const published: TransformationHistory[] = []
    let refreshes = 0
    const result = await commitWithRollback(previous, next, {
      setActive: (history) => published.push(history),
      refresh: async () => {
        refreshes += 1
        if (refreshes === 1) {
          throw new Error('Conversion Error: Could not convert string "US" to INT32')
        }
      },
    })
    expect(published).toEqual([next, previous])
    expect(refreshes).toBe(2)
    expect(result.message).toContain('Conversion Error')
    expect(result.restoreFailed).toBe(false)
  })

  it('q-8: rolls back on a value-free engine class and renders no value fragment', async () => {
    const published: TransformationHistory[] = []
    let refreshes = 0
    const result = await commitWithRollback(previous, next, {
      setActive: (history) => published.push(history),
      refresh: async () => {
        refreshes += 1
        if (refreshes === 1) {
          throw new Error('the edited view could not be materialized')
        }
      },
    })
    // The failed overlay was published, then the previous one restored and
    // re-materialized: setActive(next) → setActive(previous) → refresh twice.
    expect(published).toEqual([next, previous])
    expect(refreshes).toBe(2)
    expect(result.message).toBe(
      'The engine rejected this edit: the edited view could not be materialized. ' +
        'The previous view is unchanged.',
    )
    expect(result.restoreFailed).toBe(false)
  })

  it('attributes a double failure honestly and flags the view as unrestored', async () => {
    const published: TransformationHistory[] = []
    const result = await commitWithRollback(previous, next, {
      setActive: (history) => published.push(history),
      refresh: async () => {
        throw new Error('_setThrew is not defined')
      },
    })
    expect(published).toEqual([next, previous])
    // The message must name BOTH failures and must NOT make the value-only
    // claim for the opaque glue error (m4-3 carry-over b).
    expect(result.message).not.toContain("the column's type rejected the value")
    expect(result.message).toContain('the engine or view rejected it')
    expect(result.message).toContain('Restoring the previous view also failed')
    expect(result.message).toContain('Retry')
    expect(result.restoreFailed).toBe(true)
  })

  it('does not report a restored view when the restore refresh fails', async () => {
    let refreshes = 0
    const result = await commitWithRollback(previous, next, {
      setActive: () => {},
      refresh: async () => {
        refreshes += 1
        throw new Error('engine unavailable')
      },
    })
    expect(refreshes).toBe(2)
    expect(result.restoreFailed).toBe(true)
    expect(result.message).toContain('Restoring the previous view also failed')
    expect(result.message).toContain('engine unavailable')
  })
})
