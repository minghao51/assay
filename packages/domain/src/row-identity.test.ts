// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { baseRowId, displayRowKey, exportRowKey, insertRowId, parseRowId } from './row-identity'
import type { RowId } from './row-identity'
import { genAnchor, makeTestRng } from './property-testing'

describe('row identity — derivation shape', () => {
  it('derives base ids from (baseAnchor, base ordinal) and insert ids from (overlayAnchor, seq)', () => {
    expect(baseRowId('file-v1', 0)).toBe('base:file-v1#0')
    expect(baseRowId('file-v1', 12345)).toBe('base:file-v1#12345')
    expect(insertRowId('session-1', 7)).toBe('ins:session-1#7')
  })

  it('parse ∘ derive is the identity — for plain and separator-carrying anchors', () => {
    const rng = makeTestRng(20260918)
    for (let i = 0; i < 500; i++) {
      const anchor = genAnchor(rng, 'a')
      const ordinal = rng.int(0, 5000)
      const baseParsed = parseRowId(baseRowId(anchor, ordinal))
      expect(baseParsed).toEqual({ origin: 'base', anchor, ordinal })
      const seq = rng.int(0, 5000)
      const insertParsed = parseRowId(insertRowId(anchor, seq))
      expect(insertParsed).toEqual({ origin: 'insert', anchor, seq })
    }
  })

  it('injective for arbitrary anchor text: the last # separates (anchors may contain #)', () => {
    const anchors = ['a', 'a#1', 'a#1#2', ':', '#', '', 'x#', 'üñí', '0', 'file:v1#9']
    const seen = new Set<string>()
    for (const anchor of anchors) {
      for (let ordinal = 0; ordinal < 50; ordinal++) {
        const id = baseRowId(anchor, ordinal)
        expect(seen.has(id)).toBe(false)
        seen.add(id)
        expect(parseRowId(id)).toEqual({ origin: 'base', anchor, ordinal })
      }
      for (let seq = 0; seq < 50; seq++) {
        const id = insertRowId(anchor, seq)
        expect(seen.has(id)).toBe(false)
        seen.add(id)
        expect(parseRowId(id)).toEqual({ origin: 'insert', anchor, seq })
      }
    }
    // Base and insert id spaces are disjoint by prefix.
    for (const id of seen) {
      expect(id.startsWith('base:') || id.startsWith('ins:')).toBe(true)
    }
  })

  it('rejects anything not producible by derivation, including non-canonical ordinals', () => {
    const rejects: string[] = [
      '',
      'row-1',
      'BASE:file#1',
      'base:',
      'base:a',
      'base:a#',
      'base:a#007', // leading zero — not String(number) output
      'base:a#-1',
      'base:a#1.5',
      'base:a#1x',
      'base:a#+2',
      'ins:a',
      'ins:a#',
      'ins:a#01',
    ]
    for (const text of rejects) {
      expect(parseRowId(text as RowId)).toBeNull()
    }
    // Non-string garbage is unrepresentable in the RowId type; parse still
    // returns null rather than throwing for a cast value.
    expect(parseRowId('nonsense' as RowId)).toBeNull()
  })
})

describe('row identity — display/export grammar (the shared, anchor-free forms)', () => {
  it('renders base and insert keys in the canonical display/export spellings', () => {
    expect(displayRowKey('base:file-v1#0')).toBe('base #0')
    expect(displayRowKey('base:file-v1#12345')).toBe('base #12345')
    expect(displayRowKey('ins:session-1#7')).toBe('insert #7')
    expect(exportRowKey('base:file-v1#0')).toBe('base:0')
    expect(exportRowKey('base:file-v1#12345')).toBe('base:12345')
    expect(exportRowKey('ins:session-1#7')).toBe('insert:7')
  })

  it('drops the anchor token entirely from both forms', () => {
    // The anchor is a host-derived fingerprint; neither form may leak it.
    expect(displayRowKey('base:super-secret-anchor#5')).toBe('base #5')
    expect(exportRowKey('base:super-secret-anchor#5')).toBe('base:5')
    expect(displayRowKey('ins:overlay-token#5')).toBe('insert #5')
    expect(exportRowKey('ins:overlay-token#5')).toBe('insert:5')
  })

  it('degrades unparsable keys honestly — `unknown row` / `unknown`', () => {
    for (const text of ['', 'not-a-key', 'other:a#1', 'base:a#007', 'base:a#-1', 'base:a']) {
      expect(displayRowKey(text)).toBe('unknown row')
      expect(exportRowKey(text)).toBe('unknown')
    }
  })

  it('is the parse/derive identity: deriving then formatting round-trips', () => {
    const anchor = 'file-v1#with#hashes'
    for (const ordinal of [0, 1, 42, 9999]) {
      const id = baseRowId(anchor, ordinal)
      expect(displayRowKey(id)).toBe(`base #${String(ordinal)}`)
      expect(exportRowKey(id)).toBe(`base:${String(ordinal)}`)
      // Same inputs through parseRowId give the same anchor-free text.
      const parsed = parseRowId(id)
      expect(parsed).toEqual({ origin: 'base', anchor, ordinal })
      if (parsed === null || parsed.origin !== 'base') throw new Error('unreachable')
      expect(displayRowKey(id)).toBe(`base #${String(parsed.ordinal)}`)
    }
    const insertId = insertRowId('overlay#x#y', 3)
    expect(displayRowKey(insertId)).toBe('insert #3')
    expect(exportRowKey(insertId)).toBe('insert:3')
  })

  it('splits an anchor containing `#` at the last separator (the grammar is unambiguous)', () => {
    // Last-`#` split: the anchor `a#b` keeps its internal hash, so the
    // rendered ordinal/seq is the true tail, never the embedded `#b` part.
    expect(displayRowKey(baseRowId('a#b', 9))).toBe('base #9')
    expect(exportRowKey(baseRowId('a#b', 9))).toBe('base:9')
    expect(displayRowKey(insertRowId('#', 4))).toBe('insert #4')
    expect(exportRowKey(insertRowId('#', 4))).toBe('insert:4')
    // And a malformed key whose tail is not a canonical integer still
    // degrades rather than formatting an anchor fragment as an ordinal.
    expect(displayRowKey('base:a#b#c')).toBe('unknown row')
    expect(exportRowKey('base:a#b#c')).toBe('unknown')
  })
})

describe('row identity — stability (the contract m4-3/m4-2 rely on)', () => {
  it('ids depend on (anchor, ordinal), never on presentation position', () => {
    const rng = makeTestRng(777)
    const baseRowCount = 50
    const anchor = 'file-v1'
    // "Views": arbitrary permutations of the same base version — sorts,
    // filters, window refreshes. The id of logical row k is invariant.
    for (let round = 0; round < 20; round++) {
      const permutation = rng.shuffle(Array.from({ length: baseRowCount }, (_, i) => i))
      const viewIds = permutation.map((ordinal) => baseRowId(anchor, ordinal))
      for (let position = 0; position < baseRowCount; position++) {
        const logicalOrdinal = permutation[position] as number
        expect(viewIds[position]).toBe(baseRowId(anchor, logicalOrdinal))
      }
      // The id *set* of a view is exactly the base version’s id set.
      expect([...viewIds].sort()).toEqual(
        Array.from({ length: baseRowCount }, (_, k) => baseRowId(anchor, k)).sort(),
      )
    }
  })

  it('ids survive undo/redo walks as stable strings (history can reference them)', () => {
    const rng = makeTestRng(99)
    const ids = Array.from({ length: 100 }, () =>
      rng.bool()
        ? baseRowId(genAnchor(rng, 'b'), rng.int(0, 1000))
        : insertRowId(genAnchor(rng, 's'), rng.int(0, 1000)),
    )
    // Round-two derivation after "reopen": identical inputs → identical ids.
    for (const id of ids) {
      const parsed = parseRowId(id)
      expect(parsed).not.toBeNull()
      if (parsed === null) throw new Error('unreachable')
      const rederived =
        parsed.origin === 'base'
          ? baseRowId(parsed.anchor, parsed.ordinal)
          : insertRowId(parsed.anchor, parsed.seq)
      expect(rederived).toBe(id)
    }
  })

  it('the documented survival boundary: a different base version re-anchors every base row', () => {
    // Same ordinal, different base version anchor → different logical row.
    // This is the *consequence* the module documents (not solves): old ids
    // become foreign and the overlay reports row-anchor-mismatch for them.
    expect(baseRowId('file-v1', 3)).not.toBe(baseRowId('file-v2', 3))
    expect(parseRowId(baseRowId('file-v2', 3))).toEqual({
      origin: 'base',
      anchor: 'file-v2',
      ordinal: 3,
    })
  })
})
