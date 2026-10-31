// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import {
  classifyHistoryShortcut,
  isEditableTarget,
  shouldAutoExpandHistory,
} from './history-shortcut'
import type { HistoryShortcutEvent } from './history-shortcut'

/**
 * ug-6 / UG-10 unit pins for the pure rules behind the shell's Undo/Redo
 * shortcuts and the first-append History cue. No React, no App — just the
 * classifier, the editable-target predicate and the cue transition, so a
 * mutation in any of them fails here.
 */

/** A plain (non-DOM) keydown stub — the shape a real `KeyboardEvent` satisfies. */
function keydown(init: Partial<HistoryShortcutEvent> & { key: string }): HistoryShortcutEvent {
  return {
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
    target: null,
    ...init,
  }
}

/**
 * A duck-typed element stub: exactly the surface `isEditableTarget` probes
 * (`tagName`, `closest`, optional `isContentEditable`). Using stubs keeps the
 * predicate's contract explicit — a nested child of a `contenteditable` host
 * is an element whose `closest('[contenteditable]')` is non-null.
 */
function elementStub(
  tagName: string,
  options: { readonly inContentEditable?: boolean; readonly isContentEditable?: boolean } = {},
): EventTarget {
  const host = options.inContentEditable === true ? { tagName: 'DIV' } : null
  return {
    tagName,
    isContentEditable: options.isContentEditable,
    closest: (selector: string) =>
      selector === '[contenteditable]' && host !== null ? host : null,
  } as unknown as EventTarget
}

describe('ug-6 — undo/redo shortcut classification', () => {
  it('accepts ctrl+z and meta+z as undo', () => {
    expect(classifyHistoryShortcut(keydown({ key: 'z', ctrlKey: true }))).toBe('undo')
    expect(classifyHistoryShortcut(keydown({ key: 'z', metaKey: true }))).toBe('undo')
  })

  it('accepts ctrl+shift+z and meta+shift+z as redo (either letter case)', () => {
    expect(classifyHistoryShortcut(keydown({ key: 'z', ctrlKey: true, shiftKey: true }))).toBe(
      'redo',
    )
    expect(classifyHistoryShortcut(keydown({ key: 'Z', metaKey: true, shiftKey: true }))).toBe(
      'redo',
    )
  })

  it('accepts ctrl+y and meta+y as redo — the non-macOS convention', () => {
    expect(classifyHistoryShortcut(keydown({ key: 'y', ctrlKey: true }))).toBe('redo')
    expect(classifyHistoryShortcut(keydown({ key: 'Y', metaKey: true }))).toBe('redo')
  })

  it('rejects plain keys, alt combinations and ctrl+shift+y', () => {
    expect(classifyHistoryShortcut(keydown({ key: 'z' }))).toBeNull()
    expect(classifyHistoryShortcut(keydown({ key: 'y' }))).toBeNull()
    expect(classifyHistoryShortcut(keydown({ key: 'z', ctrlKey: true, altKey: true }))).toBeNull()
    expect(
      classifyHistoryShortcut(keydown({ key: 'z', metaKey: true, altKey: true, shiftKey: true })),
    ).toBeNull()
    // Ctrl+Shift+Y is NOT the redo gesture (it is browser history/DevTools in
    // common browsers); only the documented combinations are claimed.
    expect(classifyHistoryShortcut(keydown({ key: 'y', ctrlKey: true, shiftKey: true }))).toBeNull()
    expect(classifyHistoryShortcut(keydown({ key: 'c', ctrlKey: true }))).toBeNull()
  })

  it('ignores events another handler already prevented', () => {
    expect(
      classifyHistoryShortcut(keydown({ key: 'z', ctrlKey: true, defaultPrevented: true })),
    ).toBeNull()
  })

  it('returns null for editable targets (native text undo wins)', () => {
    expect(
      classifyHistoryShortcut(keydown({ key: 'z', ctrlKey: true, target: elementStub('INPUT') })),
    ).toBeNull()
    expect(
      classifyHistoryShortcut(
        keydown({ key: 'z', ctrlKey: true, target: elementStub('TEXTAREA') }),
      ),
    ).toBeNull()
    expect(
      classifyHistoryShortcut(keydown({ key: 'z', metaKey: true, target: elementStub('SELECT') })),
    ).toBeNull()
    // A contenteditable host…
    expect(
      classifyHistoryShortcut(
        keydown({
          key: 'z',
          ctrlKey: true,
          target: elementStub('DIV', { isContentEditable: true }),
        }),
      ),
    ).toBeNull()
    // …and a nested child of one (no own contenteditable attribute).
    expect(
      classifyHistoryShortcut(
        keydown({
          key: 'z',
          ctrlKey: true,
          shiftKey: true,
          target: elementStub('SPAN', { inContentEditable: true }),
        }),
      ),
    ).toBeNull()
  })

  it('handles non-editable targets: cells, body, window and detached nodes', () => {
    expect(
      classifyHistoryShortcut(keydown({ key: 'z', ctrlKey: true, target: elementStub('TD') })),
    ).toBe('undo')
    expect(classifyHistoryShortcut(keydown({ key: 'z', ctrlKey: true, target: null }))).toBe('undo')
    // `window`/`document`/text nodes carry no `closest`, so they are not
    // editable targets (and must not throw).
    expect(isEditableTarget({} as unknown as EventTarget)).toBe(false)
    expect(isEditableTarget({ closest: () => null, tagName: 'TD' } as unknown as EventTarget)).toBe(
      false,
    )
  })

  it('treats input/textarea/select/contenteditable as editable and a cell as not', () => {
    for (const tag of ['input', 'TEXTAREA', 'Select']) {
      expect(isEditableTarget(elementStub(tag))).toBe(true)
    }
    expect(isEditableTarget(elementStub('DIV', { isContentEditable: true }))).toBe(true)
    expect(isEditableTarget(elementStub('SPAN', { inContentEditable: true }))).toBe(true)
    expect(isEditableTarget(elementStub('TD'))).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
    expect(isEditableTarget(undefined)).toBe(false)
  })
})

describe('ug-6 — first-append History cue transition', () => {
  it('fires only on the first 0 → >0 append', () => {
    expect(
      shouldAutoExpandHistory({ previousEntries: 0, nextEntries: 1, alreadyCued: false }),
    ).toBe(true)
    expect(
      shouldAutoExpandHistory({ previousEntries: 0, nextEntries: 4, alreadyCued: false }),
    ).toBe(true)
    // Later appends (previous > 0) never re-fire.
    expect(
      shouldAutoExpandHistory({ previousEntries: 1, nextEntries: 2, alreadyCued: false }),
    ).toBe(false)
    // Undo/redo leave the length alone; a dataset open/reset moves it to 0.
    expect(
      shouldAutoExpandHistory({ previousEntries: 3, nextEntries: 3, alreadyCued: false }),
    ).toBe(false)
    expect(
      shouldAutoExpandHistory({ previousEntries: 3, nextEntries: 0, alreadyCued: false }),
    ).toBe(false)
    expect(
      shouldAutoExpandHistory({ previousEntries: 0, nextEntries: 0, alreadyCued: false }),
    ).toBe(false)
  })

  it('never fires again once the cue is spent (the user collapsed History)', () => {
    expect(shouldAutoExpandHistory({ previousEntries: 0, nextEntries: 1, alreadyCued: true })).toBe(
      false,
    )
    expect(shouldAutoExpandHistory({ previousEntries: 0, nextEntries: 5, alreadyCued: true })).toBe(
      false,
    )
  })
})
