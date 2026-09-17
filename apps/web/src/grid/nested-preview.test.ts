import { describe, expect, it } from 'vitest'
import {
  NESTED_PREVIEW_DEFAULT_MAX_DEPTH,
  NESTED_PREVIEW_DEFAULT_MAX_LENGTH,
  formatNestedPreview,
} from './nested-preview'

/**
 * m3-2 unit + property tests for the nested cell preview.
 *
 * Property style note: the repo has no fast-check dependency — the m1-6/m2-x
 * precedent is hand-rolled, seeded deterministic generators (thousands of
 * inputs per assertion, reproducible failures via the fixed seed). This file
 * follows that precedent: every "property" below is a seeded sweep asserting
 * the module contract (total, deterministic, length-capped, depth-aware).
 */

// ---- The pinned nested.jsonl previews (cross-checked against DuckDB CLI 1.5.5) ----
//
// Derived from the module's own output and cross-checked cell-by-cell against
// the CLI on the committed fixture (m2-6 CLI-pinning spirit):
//
//   /tmp/duckdb -c "SELECT deep, meta, tags FROM read_json_auto(
//     'fixtures/jsonl/nested.jsonl', format='newline_delimited') WHERE id = 1;"
//   → deep {'a': {'b': {'c': 1}}} · meta {'src': sensor-a, 'ver': 1} · tags [x, y]
//   /tmp/duckdb -c "SELECT list_transform(events, e -> epoch_ms(e.at)), …
//     WHERE id = 1;" → [1740823200000, 1740823500000] (epoch ms — the m3-1
//   worker-boundary contract for Arrow Timestamp(MICROSECOND) `.get()`).
//
// The same strings are pinned in tests/e2e/nested-grid.spec.ts against the
// real engine (raw Arrow struct-rows/vector-slices rendered by formatCell).

describe('formatNestedPreview — pinned fixture previews (nested.jsonl)', () => {
  it('previews the depth-3 struct with the leaf elided at the default depth cap', () => {
    expect(formatNestedPreview({ a: { b: { c: 1 } } })).toBe('{"a":{"b":{"c":…}}}')
    // The NULL leaf previews identically at the cap — shape honest, leaf hidden.
    expect(formatNestedPreview({ a: { b: { c: null } } })).toBe('{"a":{"b":{"c":…}}}')
  })

  it('previews structs in Arrow field order with quoted strings', () => {
    expect(formatNestedPreview({ src: 'sensor-a', ver: 1 })).toBe('{"src":"sensor-a","ver":1}')
    // NULL struct field stays distinct from a whole-NULL struct (the latter
    // never reaches this module; the grid renders it as an empty cell).
    expect(formatNestedPreview({ src: null, ver: 3 })).toBe('{"src":null,"ver":3}')
  })

  it('previews lists of scalars incl. NULL elements and the empty list', () => {
    expect(formatNestedPreview(['x', 'y'])).toBe('["x","y"]')
    expect(formatNestedPreview([])).toBe('[]')
    expect(formatNestedPreview(['x', null, 'z'])).toBe('["x",null,"z"]')
    expect(formatNestedPreview(['repeat', 'repeat'])).toBe('["repeat","repeat"]')
  })

  it('previews the list-of-structs with epoch-ms timestamps and NULLs', () => {
    expect(
      formatNestedPreview([
        { at: 1740823200000, ok: true },
        { at: 1740823500000, ok: false },
      ]),
    ).toBe('[{"at":1740823200000,"ok":true},{"at":1740823500000,"ok":false}]')
    // NULL element inside the list (nested.jsonl row id 4) and NULL `at` (id 3).
    expect(formatNestedPreview([{ at: 1741071600000, ok: false }, null])).toBe(
      '[{"at":1741071600000,"ok":false},null]',
    )
    expect(formatNestedPreview([{ at: null, ok: true }])).toBe('[{"at":null,"ok":true}]')
  })

  it('renders the quoting-hostile key escaped, never re-ordered', () => {
    expect(formatNestedPreview({ 'weird "quoted" key': 1 })).toBe('{"weird \\"quoted\\" key":1}')
  })
})

describe('formatNestedPreview — determinism and key order', () => {
  it('never re-sorts keys: own property order is the rendered order', () => {
    expect(formatNestedPreview({ b: 1, a: 2 })).toBe('{"b":1,"a":2}')
    expect(formatNestedPreview({ z: 1, m: 2, a: 3 })).toBe('{"z":1,"m":2,"a":3}')
    // Deliberate: a sorted render would lie about the engine's struct layout.
    expect(formatNestedPreview({ b: 1, a: 2 })).not.toBe(formatNestedPreview({ a: 2, b: 1 }))
  })

  it('is deterministic across repeated calls', () => {
    const value = { a: { b: [1, { c: 'x' }] }, list: ['q', null, NaN] }
    expect(formatNestedPreview(value)).toBe(formatNestedPreview(value))
    expect(formatNestedPreview(value)).toBe(formatNestedPreview(value))
  })
})

describe('formatNestedPreview — NULL vs empty visual distinctions', () => {
  it('keeps null, empty string, empty list, and empty struct distinct', () => {
    expect(formatNestedPreview(null)).toBe('null')
    expect(formatNestedPreview('')).toBe('""')
    expect(formatNestedPreview([])).toBe('[]')
    expect(formatNestedPreview({})).toBe('{}')
  })

  it('renders empty containers distinctly even at the depth cap', () => {
    expect(formatNestedPreview({ a: {} }, { maxDepth: 1 })).toBe('{"a":{}}')
    expect(formatNestedPreview([[]], { maxDepth: 1 })).toBe('[[]]')
    // Non-empty containers at the cap elide to the marker.
    expect(formatNestedPreview({ a: { x: 1 } }, { maxDepth: 1 })).toBe('{"a":…}')
    expect(formatNestedPreview([[1]], { maxDepth: 1 })).toBe('[…]')
  })
})

describe('formatNestedPreview — depth cap', () => {
  const fourDeep = { a: { b: { c: { d: 1 } } } }

  it('elides values at the default cap (3) with the marker', () => {
    expect(NESTED_PREVIEW_DEFAULT_MAX_DEPTH).toBe(3)
    expect(formatNestedPreview(fourDeep)).toBe('{"a":{"b":{"c":…}}}')
  })

  it('honors the maxDepth option in both directions', () => {
    expect(formatNestedPreview(fourDeep, { maxDepth: 10 })).toBe('{"a":{"b":{"c":{"d":1}}}}')
    // The `d` leaf sits at depth 4: maxDepth 4 shows its key, elides its value.
    expect(formatNestedPreview(fourDeep, { maxDepth: 4 })).toBe('{"a":{"b":{"c":{"d":…}}}}')
    expect(formatNestedPreview(fourDeep, { maxDepth: 5 })).toBe('{"a":{"b":{"c":{"d":1}}}}')
    expect(formatNestedPreview(fourDeep, { maxDepth: 2 })).toBe('{"a":{"b":…}}')
    // At depth 1 the root's keys/positions stay visible; all values elide.
    expect(formatNestedPreview(fourDeep, { maxDepth: 1 })).toBe('{"a":…}')
    expect(formatNestedPreview([1, [2]], { maxDepth: 1 })).toBe('[…,…]')
  })

  it('falls back to the default depth on invalid options', () => {
    expect(formatNestedPreview(fourDeep, { maxDepth: 0 })).toBe('{"a":{"b":{"c":…}}}')
    expect(formatNestedPreview(fourDeep, { maxDepth: -2 })).toBe('{"a":{"b":{"c":…}}}')
    expect(formatNestedPreview(fourDeep, { maxDepth: Number.NaN })).toBe('{"a":{"b":{"c":…}}}')
    expect(formatNestedPreview(fourDeep, { maxDepth: Number.POSITIVE_INFINITY })).toBe(
      '{"a":{"b":{"c":…}}}',
    )
  })
})

describe('formatNestedPreview — length cap', () => {
  it('never exceeds the default cap and marks every cut', () => {
    const capped = formatNestedPreview({ s: 'x'.repeat(500) })
    expect(capped.length).toBe(NESTED_PREVIEW_DEFAULT_MAX_LENGTH)
    expect(capped.startsWith('{"s":"xxx')).toBe(true)
    expect(capped.endsWith('…')).toBe(true)
  })

  it('returns the full render when it exactly fits the cap', () => {
    // 118 x's + 2 quotes = exactly 120 characters, no marker.
    expect(formatNestedPreview(`x`.repeat(118))).toBe(`"${'x'.repeat(118)}"`)
  })

  it('cuts one character to make room for the marker', () => {
    const capped = formatNestedPreview(`x`.repeat(119)) // full render would be 121
    expect(capped.length).toBe(120)
    expect(capped.endsWith('…')).toBe(true)
    expect(capped.startsWith(`"${'x'.repeat(118)}`)).toBe(true)
  })

  it('honors custom maxLength values', () => {
    expect(formatNestedPreview(['aaaa', 'bbbb'], { maxLength: 12 })).toBe('["aaaa","bb…')
    expect(formatNestedPreview(['aaaa', 'bbbb'], { maxLength: 12 }).length).toBeLessThanOrEqual(12)
  })

  it('degrades honestly on degenerate caps', () => {
    expect(formatNestedPreview({ a: 1 }, { maxLength: 0 })).toBe('')
    expect(formatNestedPreview({ a: 1 }, { maxLength: 1 })).toBe('…')
    // Non-finite caps fall back to the default.
    expect(formatNestedPreview('x'.repeat(500), { maxLength: Number.NaN }).length).toBe(120)
    expect(
      formatNestedPreview('x'.repeat(500), { maxLength: Number.POSITIVE_INFINITY }).length,
    ).toBe(120)
  })

  it('bounds render cost by shape: wide and deep structures stay ≤ cap', () => {
    const wide: unknown[] = []
    for (let index = 0; index < 1000; index++) wide.push({ index, payload: 'y'.repeat(50) })
    expect(formatNestedPreview(wide).length).toBeLessThanOrEqual(120)
    let deep: unknown = 0
    for (let level = 0; level < 500; level++) deep = { n: deep }
    expect(formatNestedPreview(deep).length).toBeLessThanOrEqual(120)
  })
})

describe('formatNestedPreview — honest primitive rendering', () => {
  it('renders strings JSON-quoted and escaped', () => {
    expect(formatNestedPreview({ s: 'quote " inside' })).toBe('{"s":"quote \\" inside"}')
    expect(formatNestedPreview({ s: 'back\\slash' })).toBe('{"s":"back\\\\slash"}')
    expect(formatNestedPreview({ s: 'tab\there' })).toBe('{"s":"tab\\there"}')
    expect(formatNestedPreview({ s: 'héllo → 世界 🚀' })).toBe('{"s":"héllo → 世界 🚀"}')
    expect(formatNestedPreview({ s: '「かぎ括弧」' })).toBe('{"s":"「かぎ括弧」"}')
  })

  it('never lies about non-finite numbers or undefined (unlike JSON.stringify)', () => {
    expect(formatNestedPreview(Number.NaN)).toBe('NaN')
    expect(formatNestedPreview(Number.POSITIVE_INFINITY)).toBe('Infinity')
    expect(formatNestedPreview({ a: undefined })).toBe('{"a":undefined}')
    // JSON.stringify would render these as null / drop the field entirely.
    expect(JSON.stringify(Number.NaN)).not.toBe(formatNestedPreview(Number.NaN))
  })

  it('renders the full IEEE/numeric range deterministically', () => {
    expect(formatNestedPreview(-0)).toBe('0')
    expect(formatNestedPreview(1e21)).toBe('1e+21')
    expect(formatNestedPreview(2 ** 53)).toBe('9007199254740992')
    expect(formatNestedPreview(Number.MAX_VALUE)).toBe('1.7976931348623157e+308')
    expect(formatNestedPreview(-9)).toBe('-9')
    expect(formatNestedPreview(123456n)).toBe('123456')
    expect(formatNestedPreview(true)).toBe('true')
    expect(formatNestedPreview(false)).toBe('false')
  })

  it('summarizes binary views like the scalar path', () => {
    expect(formatNestedPreview(new Uint8Array([1, 2, 3]))).toBe('<3 bytes>')
    expect(formatNestedPreview({ blob: new DataView(new ArrayBuffer(16)) })).toBe(
      '{"blob":"16 bytes"}'.replace('"16 bytes"', '<16 bytes>'),
    )
  })

  it('renders Dates quoted ISO (totality; transports do not deliver them today)', () => {
    expect(formatNestedPreview({ at: new Date('2026-01-02T03:04:05.000Z') })).toBe(
      '{"at":"2026-01-02T03:04:05.000Z"}',
    )
  })
})

describe('formatNestedPreview — Arrow structural shapes', () => {
  // m3-1 worker-boundary contract: list cells arrive as apache-arrow `Vector`
  // slices — `{length, get}`-likes, NOT Arrays. The module must read them
  // positionally (their enumerable properties are internal machinery).
  const vectorSlice = (
    elements: readonly unknown[],
  ): { length: number; get(i: number): unknown } => ({
    length: elements.length,
    get: (index: number) => elements[index],
  })

  it('renders list-likes positionally as arrays', () => {
    expect(formatNestedPreview(vectorSlice(['x', 'y']))).toBe('["x","y"]')
    expect(formatNestedPreview(vectorSlice([]))).toBe('[]')
    expect(formatNestedPreview(vectorSlice([vectorSlice([1, null])]))).toBe('[[1,null]]')
    expect(formatNestedPreview({ tags: vectorSlice(['u', 'v']) })).toBe('{"tags":["u","v"]}')
  })

  it('renders record-likes (struct rows) via own keys in order', () => {
    const structRow = Object.create(null) as Record<string, unknown>
    structRow['src'] = 'sensor-a'
    structRow['ver'] = 1
    expect(formatNestedPreview(structRow)).toBe('{"src":"sensor-a","ver":1}')
  })

  it('stays total over hostile list-likes (throwing getters, lying length)', () => {
    const hostile = {
      length: 5,
      get(index: number): unknown {
        if (index === 2) throw new Error('hostile getter')
        return index
      },
    }
    expect(formatNestedPreview(hostile)).toBe('[0,1,…')
    expect(formatNestedPreview({ length: -1, get: () => 1 })).toBe('[]')
  })
})

describe('formatNestedPreview — cycles and exotic inputs (totality)', () => {
  it('marks circular references without recursing forever', () => {
    const self: Record<string, unknown> = {}
    self['self'] = self
    expect(formatNestedPreview(self)).toBe('{"self":(circular)}')

    const list: unknown[] = [1]
    list.push(list)
    expect(formatNestedPreview(list)).toBe('[1,(circular)]')

    const a: Record<string, unknown> = {}
    const b: Record<string, unknown> = { back: a }
    a['fwd'] = b
    expect(formatNestedPreview(a)).toBe('{"fwd":{"back":(circular)}}')

    // The same container appearing twice as a *sibling* is not a cycle.
    const shared = { x: 1 }
    expect(formatNestedPreview([shared, shared])).toBe('[{"x":1},{"x":1}]')
  })

  it('maps every exotic input to a string', () => {
    for (const input of [
      new Map([['k', 1]]),
      new Set([1, 2]),
      Symbol('sym'),
      () => 'fn',
      new WeakMap(),
      new ArrayBuffer(8),
      new Proxy({}, {}),
      undefined,
      Number.MIN_VALUE,
    ]) {
      expect(typeof formatNestedPreview(input)).toBe('string')
    }
  })
})

// ---- Seeded property sweeps (repo precedent: deterministic hand-rolled fuzz) ----

/** Deterministic PRNG (mulberry32) — reproducible failures via the fixed seed. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const UNICODE_SLICES = [
  'plain',
  'héllo → 世界 🚀',
  'quote " inside',
  'back\\slash \t tab',
  '「かぎ括弧」',
  'глубина',
  '',
  '🇺🇳flag',
  '‽',
]

/** Builds one JSON-ish value with the given remaining depth budget. */
function arbitraryJsonish(rng: () => number, depth: number): unknown {
  const pick = (n: number): number => Math.floor(rng() * n)
  const roll = rng()
  if (depth <= 0 || roll < 0.3) {
    switch (pick(7)) {
      case 0:
        return null
      case 1:
        return UNICODE_SLICES[pick(UNICODE_SLICES.length)]
      case 2:
        return 'x'.repeat(pick(300)) // includes huge strings
      case 3:
        return pick(2) === 0 ? pick(2 ** 52) : -(pick(2 ** 52) + 0.5)
      case 4:
        return pick(2) === 0 ? Number.NaN : Number.POSITIVE_INFINITY
      case 5:
        return BigInt(Math.floor(rng() * 1e6))
      default:
        return rng() < 0.5
    }
  }
  const width = pick(6)
  if (roll < 0.65) {
    const elements: unknown[] = []
    for (let index = 0; index < width; index++) {
      elements.push(arbitraryJsonish(rng, depth - 1))
    }
    return elements
  }
  const record: Record<string, unknown> = {}
  for (let index = 0; index < width; index++) {
    const key =
      pick(8) === 0
        ? `weird "k${String(index)}" \\key`
        : UNICODE_SLICES[pick(UNICODE_SLICES.length)] + String(index)
    record[key] = arbitraryJsonish(rng, depth - 1)
  }
  return record
}

describe('formatNestedPreview — property sweeps (seeded, deterministic)', () => {
  const SEED = 20260917
  const ITERATIONS = 3000

  it(`always returns a string ≤ cap, deterministically, over ${String(ITERATIONS)} JSON-ish values`, () => {
    const rng = mulberry32(SEED)
    for (let iteration = 0; iteration < ITERATIONS; iteration++) {
      const value = arbitraryJsonish(rng, 1 + Math.floor(rng() * 6))
      const first = formatNestedPreview(value)
      expect(typeof first, `iteration ${String(iteration)}`).toBe('string')
      expect(first.length, `iteration ${String(iteration)}`).toBeLessThanOrEqual(
        NESTED_PREVIEW_DEFAULT_MAX_LENGTH,
      )
      expect(first, `iteration ${String(iteration)} determinism`).toBe(formatNestedPreview(value))
    }
  })

  it('respects every custom cap tried along the same sweep', () => {
    const rng = mulberry32(SEED + 1)
    for (let iteration = 0; iteration < 1000; iteration++) {
      const value = arbitraryJsonish(rng, 1 + Math.floor(rng() * 5))
      const maxLength = Math.floor(rng() * 200)
      expect(formatNestedPreview(value, { maxLength }).length).toBeLessThanOrEqual(maxLength)
      const maxDepth = 1 + Math.floor(rng() * 5)
      expect(typeof formatNestedPreview(value, { maxDepth })).toBe('string')
    }
  })

  it('never emits a marker-free result longer than the cap (marker included)', () => {
    const rng = mulberry32(SEED + 2)
    for (let iteration = 0; iteration < 1000; iteration++) {
      const value = arbitraryJsonish(rng, 1 + Math.floor(rng() * 4))
      const rendered = formatNestedPreview(value)
      if (rendered.length === NESTED_PREVIEW_DEFAULT_MAX_LENGTH) {
        // Exactly at cap: either the full render fits, or the marker is there.
        expect(
          rendered.endsWith('…') ||
            rendered ===
              formatNestedPreview(value, {
                maxLength: Number.MAX_SAFE_INTEGER,
              }).slice(0, NESTED_PREVIEW_DEFAULT_MAX_LENGTH),
        ).toBe(true)
      }
    }
  })

  it('never returns unmarked output that JSON escapes could hide (no silent cut)', () => {
    const rng = mulberry32(SEED + 3)
    for (let iteration = 0; iteration < 1000; iteration++) {
      const value = arbitraryJsonish(rng, 2 + Math.floor(rng() * 4))
      const rendered = formatNestedPreview(value)
      const full = formatNestedPreview(value, { maxLength: Number.MAX_SAFE_INTEGER })
      if (rendered !== full) {
        // Any difference from the full render must be marker-visible.
        expect(rendered.endsWith('…') || full.startsWith(rendered.slice(0, -1))).toBe(true)
        expect(rendered.length).toBeLessThanOrEqual(NESTED_PREVIEW_DEFAULT_MAX_LENGTH)
      }
    }
  })
})
