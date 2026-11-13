// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import * as messages from './messages'

/**
 * WF-06 copy pin (v5 §8, C1–C16). Every string is asserted against an
 * INDEPENDENT literal here — never against another implementation constant —
 * so a reworded or partially reworded string fails instead of passing on a
 * substring (the `export/messages.test` precedent).
 *
 * Truth constraints checked structurally: no count interpolation, no "saved"
 * promise, no duration promise, no filename/path vocabulary.
 */

const APPROVED = {
  C1: 'Replace this session?',
  C2: 'This session has staged changes that are not saved. Opening another dataset replaces the session, its staged edits, its undo history, and any validation or comparison results.',
  C3: 'Session changes are not saved automatically. Export a copy to keep them.',
  C4: 'If you cancel the file chooser, or the file cannot be opened, this session stays as it is.',
  C5: 'Stay',
  C6: 'Export a copy…',
  C7: 'Choose a replacement file…',
  C8: 'Nothing was opened. This session is unchanged.',
  C9: 'Opening the new file… The current session stays open until it is ready.',
  C11: 'Choose a different file…',
  C12: 'Finish the current opening first.',
  C13: 'Finish or cancel the cell you are editing first.',
  C15: 'This session is still finishing a change. Replacement stays unavailable until it finishes.',
  C16: 'A column type check is still running. Replacement stays unavailable until it finishes.',
} as const

describe('WF-06 copy — C1–C16 byte-exact', () => {
  it('pins every approved string', () => {
    expect(messages.REPLACE_GUARD_TITLE).toBe(APPROVED.C1)
    expect(messages.REPLACE_GUARD_BODY_STAGED).toBe(APPROVED.C2)
    expect(messages.REPLACE_GUARD_BODY_EXPORT).toBe(APPROVED.C3)
    expect(messages.REPLACE_GUARD_BODY_STAYS).toBe(APPROVED.C4)
    expect(messages.REPLACE_STAY_LABEL).toBe(APPROVED.C5)
    expect(messages.REPLACE_EXPORT_LABEL).toBe(APPROVED.C6)
    expect(messages.REPLACE_CHOOSE_LABEL).toBe(APPROVED.C7)
    expect(messages.REPLACE_PICKER_NOTICE).toBe(APPROVED.C8)
    expect(messages.REPLACE_PROGRESS_TEXT).toBe(APPROVED.C9)
    expect(messages.REPLACE_RETRY_LABEL).toBe(APPROVED.C11)
    expect(messages.REPLACE_BUSY_NOTICE).toBe(APPROVED.C12)
    expect(messages.REPLACE_DRAFT_NOTICE).toBe(APPROVED.C13)
    expect(messages.REPLACE_SETTLING_NOTICE).toBe(APPROVED.C15)
    expect(messages.REPLACE_CAST_NOTICE).toBe(APPROVED.C16)
    // C10's constant tail and C9/C14's fixed labels.
    expect(messages.REPLACE_FAILURE_SUFFIX).toBe(' Nothing in this session changed.')
    expect(messages.REPLACE_PROGRESS_LABEL).toBe('Opening progress')
    expect(messages.REPLACE_TECHNICAL_SUMMARY).toBe('Technical detail')
  })

  it('uses a single U+2026 ellipsis (never three periods)', () => {
    for (const label of [
      messages.REPLACE_EXPORT_LABEL,
      messages.REPLACE_CHOOSE_LABEL,
      messages.REPLACE_RETRY_LABEL,
      messages.REPLACE_PROGRESS_TEXT,
    ]) {
      expect(label.includes('...')).toBe(false)
      expect(label.includes('\u2026')).toBe(true)
    }
  })
})

describe('WF-06 copy — truth constraints', () => {
  it('makes no saved/autosave/persistence or duration promise', () => {
    const all: string[] = Object.values(messages).map((value) => String(value))
    expect(all.length).toBeGreaterThan(0)
    for (const text of all) {
      // "not saved"/"are not saved automatically" is the only "saved" usage,
      // and it is a NEGATION; an affirmative save claim would be a new promise.
      const saved = text.match(/saved/gi) ?? []
      for (const hit of saved) {
        const at = text.toLowerCase().indexOf(hit.toLowerCase())
        expect(text.slice(Math.max(0, at - 8), at)).toMatch(/not\s*$/)
      }
      for (const forbidden of ['saved automatically in', 'we saved', 'your changes are saved']) {
        expect(text.toLowerCase()).not.toContain(forbidden)
      }
      // No duration promise (the waits are unbounded, §3.5).
      expect(text).not.toMatch(/\bin a moment\b|\bshortly\b|\bwithin \d/i)
    }
  })

  it('never names a count, filename, path or dataset value', () => {
    const all: string[] = Object.values(messages).map((value) => String(value))
    for (const text of all) {
      expect(text).not.toMatch(/\b\d+\s+(changes?|rows?|columns?)\b/i)
      expect(text).not.toMatch(/\.(parquet|csv|jsonl|json)\b.*(?:name|file)/i)
      expect(text).not.toMatch(/\/(tmp|home|Users|var)\//)
    }
  })
})
