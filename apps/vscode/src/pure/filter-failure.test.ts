// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { FilterApplyError } from '@assay/grid'
import type { FilterFailurePhase } from '@assay/grid'
import {
  FILTER_RELOAD_FAILED_MESSAGE,
  FILTER_RESTORE_FAILED_MESSAGE,
  filterFailureCopy,
  filterFailurePhase,
} from './filter-failure'

/**
 * C02c — `FilterApplyError.phase` → copy (C01 §7, §9.1 assertions 15/16, §10
 * decisions 4–5) for the desktop surface.
 *
 * The pins: the three phases map to three DIFFERENT sentences; only
 * `refused-before-change` may claim the previous filters are still in effect;
 * `accepted-reload-failed` is never a rollback and never interpolates the
 * reload error (`model.reloadError` is diagnostics only); `restore-failed`
 * states the unknown list and offers the Clear affordance. Nothing renders a
 * predicate, a column name, a cell value or an engine diagnostic in the
 * reload/restore sentences.
 */
const VIOLENT = 'VIOLENT_SENTINEL'
const PREDICATE = `= '${VIOLENT}'`
const COLUMN = `${VIOLENT}_column`

/** A provider rejection the model would wrap; carries a violent message. */
function violentCause(): Error {
  return new Error(
    `Binder Error: Referenced column "${VIOLENT}" not found in FROM clause!\n` +
      `LINE 1: SELECT * FROM "t" WHERE ("${COLUMN}" ${PREDICATE})`,
  )
}

function appliesPhase(phase: FilterFailurePhase): FilterApplyError {
  return new FilterApplyError(phase, violentCause())
}

describe('filterFailurePhase — value-free classification', () => {
  it('reads the phase off a FilterApplyError and reports null for anything else', () => {
    expect(filterFailurePhase(appliesPhase('refused-before-change'))).toBe('refused-before-change')
    expect(filterFailurePhase(appliesPhase('accepted-reload-failed'))).toBe(
      'accepted-reload-failed',
    )
    expect(filterFailurePhase(appliesPhase('restore-failed'))).toBe('restore-failed')
    // A malformed spec is a plain TypeError, not a transaction outcome.
    expect(filterFailurePhase(new TypeError('bad spec'))).toBeNull()
    expect(filterFailurePhase(undefined)).toBeNull()
  })
})

describe('filterFailureCopy — phase to sentence', () => {
  it('refused-before-change keeps the pre-C02 sentence and offers no recovery control', () => {
    const copy = filterFailureCopy(appliesPhase('refused-before-change'))
    expect(copy.message).toBe(
      `The filter could not be applied: Binder Error: Referenced column "${VIOLENT}" not found in ` +
        'FROM clause. The previous filters are still in effect.',
    )
    expect(copy.message).not.toMatch(/\r|\n/)
    expect(copy.recovery).toBeNull()
  })

  it('accepted-reload-failed never claims a rollback and never renders the reload error', () => {
    const copy = filterFailureCopy(appliesPhase('accepted-reload-failed'))
    // C01 §10 decision 5 — the accepted list stays effective; only the view
    // needs a reload.
    expect(copy.message).toBe(FILTER_RELOAD_FAILED_MESSAGE)
    expect(copy.message).toBe(
      'The filters were applied, but the grid could not be reloaded. Retry to reload the view.',
    )
    // The whole point of case (b): no "previous filters" claim, ever.
    expect(copy.message).not.toContain('previous filters')
    expect(copy.message).not.toContain('still in effect')
    expect(copy.message).not.toContain('restored')
    // Value-free: no sentinel, no engine text, no SQL tail, one line.
    expect(copy.message).not.toContain(VIOLENT)
    expect(copy.message).not.toContain('Binder Error')
    expect(copy.message).not.toContain('LINE 1')
    expect(copy.message).not.toMatch(/\r|\n/)
    // The recovery is the model's own reload, not a second filter write.
    expect(copy.recovery).toEqual({ kind: 'retry' })
  })

  it('restore-failed states the unknown list and offers the Clear affordance', () => {
    const copy = filterFailureCopy(appliesPhase('restore-failed'))
    expect(copy.message).toBe(FILTER_RESTORE_FAILED_MESSAGE)
    expect(copy.message).toContain('could not be restored')
    expect(copy.message).toContain('unknown')
    // Neither list may be claimed as effective...
    expect(copy.message).not.toContain('still in effect')
    expect(copy.message).not.toContain('are back in effect')
    // ...and the documented way back is named.
    expect(copy.message).toContain('clear the filters')
    expect(copy.recovery).toEqual({ kind: 'clear' })
    expect(copy.message).not.toContain(VIOLENT)
    expect(copy.message).not.toMatch(/\r|\n/)
  })

  it('distinguishes all three phases (no two share a sentence)', () => {
    const messages = (
      ['refused-before-change', 'accepted-reload-failed', 'restore-failed'] as const
    ).map((phase) => filterFailureCopy(appliesPhase(phase)).message)
    expect(new Set(messages).size).toBe(3)
  })

  it('a non-transaction rejection keeps the framed filter sentence and offers nothing', () => {
    const copy = filterFailureCopy(new TypeError(`spec for ${VIOLENT} is malformed`))
    expect(copy.message).toBe(
      `The filter could not be applied: spec for ${VIOLENT} is malformed. ` +
        'The previous filters are still in effect.',
    )
    expect(copy.recovery).toBeNull()
  })

  it('degrades an empty or opaque-glue message to the fallback sentence', () => {
    expect(filterFailureCopy(appliesPhase('refused-before-change')).message).not.toContain(
      '_setThrew',
    )
    const empty = filterFailureCopy(new FilterApplyError('refused-before-change', new Error('')))
    expect(empty.message).toBe(
      'The filter could not be applied: the engine reported an error. ' +
        'The previous filters are still in effect.',
    )
    const glue = filterFailureCopy(
      new FilterApplyError('refused-before-change', new Error('_setThrew is not defined')),
    )
    expect(glue.message).toBe(
      'The filter could not be applied: the engine reported an error. ' +
        'The previous filters are still in effect.',
    )
  })
})
