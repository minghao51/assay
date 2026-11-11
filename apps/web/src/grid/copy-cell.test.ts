// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { parseDuckDbType } from '../schema/parseType'
import {
  CELL_COPY_ANNOUNCEMENTS,
  composeCellCopyText,
  isCellCopyShortcut,
  isEditorControlTarget,
} from './copy-cell'
import { formatCell } from './format'

/**
 * ug-5 (UG-11) unit pins for the copy composition and the shortcut predicate.
 *
 * The composer MUST mirror the cell render path byte-for-byte: every case
 * below compares `composeCellCopyText(...)` with `formatCell(...)` (the exact
 * call `DataGrid.tsx` renders with) and, where relevant, with the literal the
 * user sees. `String(rawValue)` regressions are explicitly killed: decimal
 * payloads arrive as 16-byte Arrow views and would copy as `128,88,79,0,…`.
 *
 * The predicate MUST reject every gesture the grid does not own — plain `c`,
 * extra modifiers, and any editor-control target — so native copy inside an
 * editor keeps working (ADR 0025: no clipboard use from engine output; the
 * copy is user-initiated and local).
 */

/** Arrow `DecimalBigNum` shape for `DECIMAL(10,2)` unscaled 5_200_000 (`52000.00`). */
function decimalPayload(): Uint8Array {
  const payload = new Uint8Array(16)
  payload.set([0x80, 0x58, 0x4f, 0x00])
  return payload
}

function element(tagName: string): HTMLElement {
  return document.createElement(tagName)
}

describe('composeCellCopyText — copy the display value, never String(raw)', () => {
  it('copies a string exactly as the cell renders it', () => {
    expect(composeCellCopyText('row-7', 'VARCHAR')).toBe('row-7')
    expect(composeCellCopyText('row-7', 'VARCHAR')).toBe(formatCell('row-7', 'VARCHAR'))
  })

  it('copies the decoded decimal, not the raw Arrow byte view', () => {
    const payload = decimalPayload()
    const copied = composeCellCopyText(payload, 'DECIMAL(10,2)')
    expect(copied).toBe('52000.00')
    expect(copied).toBe(formatCell(payload, 'DECIMAL(10,2)'))
    // The mutation-drill pin: composing from the raw value would produce this.
    expect(copied).not.toBe(String(payload))
    // Parsed-type form (the grid precomputes it per column) agrees.
    expect(composeCellCopyText(payload, 'DECIMAL(10,2)', parseDuckDbType('DECIMAL(10,2)'))).toBe(
      '52000.00',
    )
    // A bigint decimal value (defensive path) decodes the same way.
    expect(composeCellCopyText(5200000n, 'DECIMAL(10,2)')).toBe('52000.00')
  })

  it('copies dates as the ISO string the cell shows', () => {
    const value = new Date('2026-01-02T03:04:05.000Z')
    expect(composeCellCopyText(value, 'TIMESTAMP')).toBe('2026-01-02T03:04:05.000Z')
    expect(composeCellCopyText(value, 'TIMESTAMP')).toBe(formatCell(value, 'TIMESTAMP'))
  })

  it('copies typed temporals exactly as the cell renders them (wf-01)', () => {
    // The cell body and the focused copy both compose through `formatCell`, so
    // the clipped text is byte-identical to what the user sees — for every
    // fraction width, and for the raw fallback of a lossy delivery.
    const cases: ReadonlyArray<readonly [unknown, string, string]> = [
      [1709164800000, 'DATE', '2024-02-29'],
      [1709214312123.456, 'TIMESTAMP', '2024-02-29T13:45:12.123456Z'],
      [1709214312123, 'TIMESTAMP_MS', '2024-02-29T13:45:12.123Z'],
      [1709214312000, 'TIMESTAMP_S', '2024-02-29T13:45:12Z'],
      [-0.001, 'TIMESTAMP', '1969-12-31T23:59:59.999999Z'],
      [49512123456n, 'TIME', '13:45:12.123456'],
      [0n, 'TIME', '00:00:00'],
      [1709214312123.4568, 'TIMESTAMP_NS', '1709214312123.4568'],
    ]
    for (const [value, type, expected] of cases) {
      const copied = composeCellCopyText(value, type)
      expect(copied, `${type}: ${String(value)}`).toBe(expected)
      expect(copied, `${type}: rendered cell text`).toBe(formatCell(value, type))
    }
    // A NULL temporal cell has nothing to copy (the empty announcement fires).
    expect(composeCellCopyText(null, 'TIMESTAMP')).toBeNull()
  })

  it('copies a boolean as its display text', () => {
    expect(composeCellCopyText(false, 'BOOLEAN')).toBe('false')
    expect(composeCellCopyText(true, 'BOOLEAN')).toBe('true')
  })

  it('treats NULL (and an empty display) as nothing to copy', () => {
    expect(composeCellCopyText(null, 'BIGINT')).toBeNull()
    expect(composeCellCopyText(undefined, 'BIGINT')).toBeNull()
    // `formatCell('')` is '' too: an empty cell displays nothing, so there is
    // nothing to put on the clipboard (the announcement explains the no-op).
    expect(composeCellCopyText('', 'VARCHAR')).toBeNull()
  })

  it('copies the bounded nested struct/list preview the cell shows', () => {
    const struct = { name: 'n1', tags: ['x', 'y'] }
    const structType = 'STRUCT("name" VARCHAR, "tags" VARCHAR[])'
    expect(composeCellCopyText(struct, structType)).toBe('{"name":"n1","tags":["x","y"]}')
    expect(composeCellCopyText(struct, structType)).toBe(formatCell(struct, structType))

    const list = [{ at: 1740823200000, ok: true }, null]
    expect(composeCellCopyText(list, 'STRUCT("at" BIGINT, "ok" BOOLEAN)[]')).toBe(
      '[{"at":1740823200000,"ok":true},null]',
    )
    // The depth-capped preview is copied honestly (never a raw dump).
    expect(composeCellCopyText({ a: { b: { c: 1 } } })).toBe('{"a":{"b":{"c":…}}}')
  })
})

describe('isCellCopyShortcut — only the grid-owned Ctrl/Cmd+C gesture', () => {
  const cell = element('div')

  it('accepts Ctrl+C, Meta+C and an uppercase key', () => {
    expect(isCellCopyShortcut({ key: 'c', ctrlKey: true, target: cell })).toBe(true)
    expect(isCellCopyShortcut({ key: 'c', metaKey: true, target: cell })).toBe(true)
    expect(isCellCopyShortcut({ key: 'C', ctrlKey: true, target: cell })).toBe(true)
    // No target (a synthetic event) is not an editor control.
    expect(isCellCopyShortcut({ key: 'c', ctrlKey: true })).toBe(true)
  })

  it('rejects plain c and every extra-modifier combination', () => {
    expect(isCellCopyShortcut({ key: 'c', target: cell })).toBe(false)
    expect(isCellCopyShortcut({ key: 'c', ctrlKey: true, shiftKey: true, target: cell })).toBe(
      false,
    )
    expect(isCellCopyShortcut({ key: 'c', ctrlKey: true, altKey: true, target: cell })).toBe(false)
    expect(isCellCopyShortcut({ key: 'c', metaKey: true, altKey: true, target: cell })).toBe(false)
    expect(isCellCopyShortcut({ key: 'c', metaKey: true, shiftKey: true, target: cell })).toBe(
      false,
    )
    expect(isCellCopyShortcut({ key: 'v', ctrlKey: true, target: cell })).toBe(false)
    expect(isCellCopyShortcut({ key: 'Enter', ctrlKey: true, target: cell })).toBe(false)
  })

  it('rejects editor controls so native copy keeps working inside them', () => {
    for (const tagName of ['input', 'select', 'textarea']) {
      expect(isEditorControlTarget(element(tagName))).toBe(true)
      expect(isCellCopyShortcut({ key: 'c', ctrlKey: true, target: element(tagName) })).toBe(false)
    }

    const editable = element('div')
    editable.setAttribute('contenteditable', 'true')
    const nested = element('span')
    editable.append(nested)
    expect(isEditorControlTarget(editable)).toBe(true)
    expect(isEditorControlTarget(nested)).toBe(true)
    expect(isCellCopyShortcut({ key: 'c', metaKey: true, target: nested })).toBe(false)

    // A normal cell/row element is not an editor control.
    expect(isEditorControlTarget(cell)).toBe(false)
    expect(isEditorControlTarget(null)).toBe(false)
    expect(isEditorControlTarget(undefined)).toBe(false)
  })
})

describe('CELL_COPY_ANNOUNCEMENTS — byte-exact and value-free', () => {
  it('pins the three messages (em dash, single spaces)', () => {
    expect(CELL_COPY_ANNOUNCEMENTS).toEqual({
      copied: 'Value copied.',
      empty: 'Nothing to copy — this cell is empty.',
      failed: 'Copy failed — the clipboard is unavailable.',
    })
  })

  it('never interpolates a value into an announcement', () => {
    for (const message of Object.values(CELL_COPY_ANNOUNCEMENTS)) {
      expect(message).not.toContain('${')
      expect(message).not.toContain('%s')
      expect(message).not.toContain('52000')
    }
  })
})
