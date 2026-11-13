// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import type { OverlayBase, TransformationHistory } from '@assay/domain'
import {
  appendOp,
  baseRowId,
  emptyHistory,
  foldOverlay,
  insertRowId,
  redo,
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
  hasAppliedChanges,
  openFailureMessage,
  overlaySnapshot,
  resolveProfileColumn,
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

  it('strips every line-break shape, so no newline survives into a message (UG-30)', () => {
    // Every member of the LINE_BREAK class, one per case. `\r\n` is covered as
    // a shape in its own right, but note that its *removal* alone is masked by
    // the `\r`/`\n` members of the same class (splitting on either still
    // yields the first line); each of the other seven is individually
    // load-bearing — dropping one from the regex fails its case.
    const breaks = ['\n', '\r\n', '\r', '\v', '\f', '\u0085', '\u2028', '\u2029']
    for (const breakage of breaks) {
      const raw = `first line${breakage}second line`
      const line = engineErrorLine(raw, 'fallback')
      expect(line, `break ${JSON.stringify(breakage)}`).toBe('first line')
      expect(line, `break ${JSON.stringify(breakage)}`).not.toMatch(
        /\r|\n|\v|\f|\u0085|\u2028|\u2029/,
      )
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

  it('classifies a DOM file-read failure by exception name, not its generic message', () => {
    // `FileSystemFileHandle.getFile()` rejects with a `DOMException` whose
    // name carries the cause; its message is a generic sentence with no
    // file-shaped `not found` spelling, so the text signals cannot see it.
    const domMissingFileMessage =
      'A requested file or directory could not be found at the time this operation was executed.'
    // The message alone is NOT file evidence — this is why the name is used.
    expect(classifyOpenFailure(domMissingFileMessage)).toBe('unknown')
    expect(classifyOpenFailure(domMissingFileMessage, 'NotFoundError')).toBe('unreadable')
    const error = new DOMException(domMissingFileMessage, 'NotFoundError')
    expect(engineErrorDetail(error)).toBe(domMissingFileMessage)
    expect(openFailureMessage(error)).toBe(
      'The file could not be opened. The file could not be read. It may be corrupt, truncated, or not the format its name suggests.',
    )
  })

  it('treats every DOM file-read exception name as unreadable, whatever its message', () => {
    for (const name of ['NotFoundError', 'NotReadableError', 'EncodingError', 'SecurityError']) {
      const message = openFailureMessage(new DOMException('the operation failed', name))
      expect(message, name).toContain('could not be read')
      expect(message, name).not.toContain('the operation failed')
    }
    // Only the file-read names are evidence: another `DOMException` name is
    // not a file signal and must stay cause-neutral.
    expect(openFailureMessage(new DOMException('the operation was aborted', 'AbortError'))).toBe(
      'The file could not be opened. You can try another file.',
    )
  })

  it('keeps missing-column and missing-table engine errors cause-neutral', () => {
    // A bare `not found` (and `does not exist`) is DuckDB's missing-column/
    // table vocabulary, not file evidence — the name check must not resurrect
    // text matching for either.
    for (const error of [
      new Error('Binder Error: Referenced column "amount" not found in FROM clause!'),
      new Error('Binder Error: Referenced table "orders" not found!'),
      new Error('Catalog Error: Table with name orders does not exist!'),
    ]) {
      expect(classifyOpenFailure(engineErrorDetail(error))).toBe('unknown')
      const message = openFailureMessage(error)
      expect(message).toBe('The file could not be opened. You can try another file.')
      expect(message).not.toContain('could not be read')
    }
  })

  it('leaves the opaque mvp glue error unclassified instead of calling the file unreadable', () => {
    // `_setThrew` is the mvp bundle's opaque emscripten glue failure. The
    // `op-channel` notes it can also mean operation collisions, and the open
    // chain catches post-read stages too, so it is NOT file evidence: it must
    // fall through to the cause-neutral fallback, never "could not be read".
    const error = new Error('_setThrew is not defined')
    expect(classifyOpenFailure(engineErrorDetail(error))).toBe('unknown')
    const message = openFailureMessage(error)
    expect(message).toBe('The file could not be opened. You can try another file.')
    expect(message).not.toContain('_setThrew')
    expect(message).not.toContain('could not be read')
    expect(message).not.toMatch(/corrupt|truncated|format/i)
  })

  it('uses cause-neutral copy for a post-open-stage failure (schema/count/view/panel import)', () => {
    // `openDataFile` catches the schema, row-count, view-load and panel-chunk
    // stages in the same handler that catches file reads. Those failures reach
    // the `unknown` class, whose copy must not claim the file was unreadable.
    for (const stageError of [
      new Error('Binder Error: Referenced column "id" not found in FROM clause!'),
      'the edited view could not be materialized',
      new Error('Failed to fetch dynamically imported module: /assets/SqlPanel.js'),
    ]) {
      expect(classifyOpenFailure(engineErrorDetail(stageError))).toBe('unknown')
      const message = openFailureMessage(stageError)
      expect(message).toBe('The file could not be opened. You can try another file.')
      expect(message).not.toContain('could not be read')
      expect(message).not.toMatch(/corrupt|truncated|not the format/i)
    }
  })

  it('falls back to the cause-neutral copy for an unrecognised failure', () => {
    expect(classifyOpenFailure('something unexpected')).toBe('unknown')
    expect(openFailureMessage(new Error('something unexpected'))).toBe(
      'The file could not be opened. You can try another file.',
    )
  })

  it('classifies from the STORED exception name the caller passes (live open path)', () => {
    // App keeps only the message and the exception name in `Phase['error']`;
    // the exception object is gone by render time. The stored name must be
    // authoritative — the generic DOM message is not file evidence.
    const domMissingFileMessage =
      'A requested file or directory could not be found at the time this operation was executed.'
    expect(openFailureMessage(domMissingFileMessage, 'NotFoundError')).toBe(
      'The file could not be opened. The file could not be read. It may be corrupt, truncated, or not the format its name suggests.',
    )
    // No stored name + a generic message stays cause-neutral: nothing claims
    // the file could not be read.
    expect(openFailureMessage('generic message')).toBe(
      'The file could not be opened. You can try another file.',
    )
    expect(openFailureMessage('generic message', undefined)).toBe(
      'The file could not be opened. You can try another file.',
    )
    // A supplied name that is not a file-read exception is not evidence either.
    expect(openFailureMessage('generic message', 'AbortError')).toBe(
      'The file could not be opened. You can try another file.',
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

/**
 * ug-16 design §4.1 — base-derived profile column resolution against the
 * *current* effective schema. These pins are the resolver half; the copy and
 * the compile half live in `profile/filter-action.test.ts`.
 */
describe('resolveProfileColumn — base-derived names on the edited view (ug-16)', () => {
  const rename = (from: string, to: string) => ({ kind: 'column-rename' as const, from, to })
  const schema = (...names: string[]): { name: string; type: string }[] =>
    names.map((name) => ({ name, type: 'VARCHAR' }))

  it('resolves a name present in the effective schema as itself', () => {
    expect(resolveProfileColumn('country', [], schema('id', 'country'))).toEqual({
      kind: 'resolved',
      column: 'country',
    })
  })

  it('follows a single active rename and reports both names', () => {
    expect(
      resolveProfileColumn('country', [rename('country', 'nation')], schema('id', 'nation')),
    ).toEqual({ kind: 'renamed', base: 'country', current: 'nation' })
  })

  it('follows a chained rename in op order (a→b→c lands on c)', () => {
    expect(
      resolveProfileColumn(
        'country',
        [rename('country', 'nation'), rename('nation', 'homeland')],
        schema('id', 'homeland'),
      ),
    ).toEqual({ kind: 'renamed', base: 'country', current: 'homeland' })
  })

  it('resolves a rename chain that returns to the original name as itself', () => {
    expect(
      resolveProfileColumn(
        'country',
        [rename('country', 'nation'), rename('nation', 'country')],
        schema('id', 'country'),
      ),
    ).toEqual({ kind: 'resolved', column: 'country' })
  })

  it('is unresolved when neither the base name nor the chain end is in the schema', () => {
    // A future column-drop (or a chain whose end is gone) falls here: the
    // generic refusal, never a guess.
    expect(resolveProfileColumn('country', [], schema('id', 'income'))).toEqual({
      kind: 'unresolved',
      base: 'country',
    })
    expect(
      resolveProfileColumn('country', [rename('country', 'nation')], schema('id', 'income')),
    ).toEqual({ kind: 'unresolved', base: 'country' })
  })

  it('ignores non-rename ops and other columns\u2019 renames (mixed columns)', () => {
    const ops = [
      {
        kind: 'cell-set' as const,
        rowId: baseRowId(BASE.baseAnchor, 0),
        column: 'label',
        value: { kind: 'string' as const, value: 'a' },
      },
      { kind: 'column-cast' as const, column: 'id', targetType: 'VARCHAR' },
      rename('label', 'caption'),
    ]
    // `country` is untouched by any of them.
    expect(resolveProfileColumn('country', ops, schema('id', 'country', 'caption'))).toEqual({
      kind: 'resolved',
      column: 'country',
    })
    // ...and the renamed column follows its own chain.
    expect(resolveProfileColumn('label', ops, schema('id', 'country', 'caption'))).toEqual({
      kind: 'renamed',
      base: 'label',
      current: 'caption',
    })
  })

  it('re-resolves per click from the active ops, so undo/redo change the answer', () => {
    const first = appendOp(BASE, emptyHistory(), rename('label', 'caption'))
    const second = appendOp(BASE, first.history, rename('caption', 'title'))

    // cursor 2: both renames active → base `label` lands on `title`.
    expect(resolveProfileColumn('label', activeOps(second.history), schema('id', 'title'))).toEqual(
      { kind: 'renamed', base: 'label', current: 'title' },
    )

    // Undo one: only the first rename is active → `caption` is the current name.
    const undone = undo(second.history).history
    expect(activeOps(undone)).toHaveLength(1)
    expect(resolveProfileColumn('label', activeOps(undone), schema('id', 'caption'))).toEqual({
      kind: 'renamed',
      base: 'label',
      current: 'caption',
    })

    // Undo to 0: no active op, the base name resolves as itself again.
    const undoneAll = undo(undone).history
    expect(activeOps(undoneAll)).toHaveLength(0)
    expect(resolveProfileColumn('label', activeOps(undoneAll), schema('id', 'label'))).toEqual({
      kind: 'resolved',
      column: 'label',
    })

    // Redo re-applies the chain (cursor 1 → renamed again).
    const redone = redo(undoneAll).history
    expect(resolveProfileColumn('label', activeOps(redone), schema('id', 'caption'))).toEqual({
      kind: 'renamed',
      base: 'label',
      current: 'caption',
    })
  })

  it('treats a rename chain end that is absent from the schema as unresolved (no guessing)', () => {
    // `label` → `caption`, but the effective schema only has the intermediate
    // spelling: nothing in the chain lands, so the answer is a generic refusal.
    expect(
      resolveProfileColumn('label', [rename('label', 'caption')], schema('id', 'label-x')),
    ).toEqual({ kind: 'unresolved', base: 'label' })
  })
})

/**
 * WF-06 §2 — the adopted "dirty" predicate. Evaluated only on a SETTLED
 * history (`historyRef.current`), which is the gate's G6.
 *
 * The wrong alternatives are pinned as behaviour here: `entries.length` would
 * call an undone-to-zero history dirty, `cursor > 0` would call a no-op-only
 * prefix dirty, and `activeOps().length` would over-report logged no-ops.
 */
describe('hasAppliedChanges — the adopted dirty predicate (WF-06 §2)', () => {
  it('is clean for an empty history', () => {
    expect(hasAppliedChanges(emptyHistory())).toBe(false)
  })

  it('is dirty after one applied op and clean again after undo-to-zero', () => {
    const applied = appendOp(BASE, emptyHistory(), {
      kind: 'column-rename',
      from: 'label',
      to: 'tag',
    })
    expect(applied.entry?.outcome.status).toBe('applied')
    expect(hasAppliedChanges(applied.history)).toBe(true)
    // Undo back to the start: the entry survives in the buffer, but the active
    // prefix has no applied outcome — clean, not "entries.length > 0".
    const undone = undo(applied.history)
    expect(undone.history.entries.length).toBe(1)
    expect(undone.history.cursor).toBe(0)
    expect(hasAppliedChanges(undone.history)).toBe(false)
  })

  it('is clean for a logged no-op-only history', () => {
    const noOp = appendOp(BASE, emptyHistory(), {
      kind: 'column-rename',
      from: 'label',
      to: 'label',
    })
    expect(noOp.entry).not.toBeNull()
    expect(noOp.entry?.outcome.status).not.toBe('applied')
    expect(noOp.history.entries.length).toBe(1)
    expect(hasAppliedChanges(noOp.history)).toBe(false)
    expect(activeOps(noOp.history)).toHaveLength(1)
  })

  it('is clean for a redo tail that is not active', () => {
    const first = appendOp(BASE, emptyHistory(), {
      kind: 'column-rename',
      from: 'label',
      to: 'tag',
    })
    const undone = undo(first.history).history
    const redone = redo(undone)
    // Undo again: the applied op is the redo tail only — clean by policy.
    const tailOnly = undo(redone.history).history
    expect(tailOnly.entries.length).toBe(1)
    expect(tailOnly.cursor).toBe(0)
    expect(hasAppliedChanges(tailOnly)).toBe(false)
  })

  it('stays dirty for A→B→A (the accepted over-report)', () => {
    const first = appendOp(BASE, emptyHistory(), {
      kind: 'column-rename',
      from: 'label',
      to: 'tag',
    })
    const second = appendOp(BASE, first.history, {
      kind: 'column-rename',
      from: 'tag',
      to: 'label',
    })
    expect(second.entry?.outcome.status).toBe('applied')
    // The net effect is the base again, but two applied outcomes ran: dirty.
    expect(hasAppliedChanges(second.history)).toBe(true)
  })

  it('reads only the active prefix, never the whole entry list', () => {
    const first = appendOp(BASE, emptyHistory(), {
      kind: 'column-rename',
      from: 'label',
      to: 'tag',
    })
    const second = appendOp(BASE, first.history, {
      kind: 'column-rename',
      from: 'tag',
      to: 'caption',
    })
    // Move the cursor back one: the first op is applied, the second is tail.
    const cursor: TransformationHistory = { ...second.history, cursor: 1 }
    expect(hasAppliedChanges(cursor)).toBe(true)
    const zero: TransformationHistory = { ...second.history, cursor: 0 }
    expect(hasAppliedChanges(zero)).toBe(false)
  })
})
