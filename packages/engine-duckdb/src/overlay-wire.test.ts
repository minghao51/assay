// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for the overlay payload boundary validation
 * (`overlay-wire.ts`, m4-2). The worker re-validates everything crossing
 * the postMessage boundary, so these tests pin:
 *
 * - the five cell-value kinds parse round-trip-shape (including `text`, the
 *   engine-parseable literal cast, and `{ kind: 'null' }` as data);
 * - every op kind of the closed 8-kind union parses; unknown kinds, missing
 *   fields, wrong payload types, and non-Map insert values are rejected
 *   (the request is then refused — never silently coerced);
 * - base metadata checks: unique column names (host contract), safe
 *   non-negative baseRowCount, string anchors;
 * - semantic problems (malformed row ids, foreign anchors, unknown columns)
 *   are deliberately NOT the parser's job — they are the fold's typed
 *   outcomes — so a payload carrying them still parses.
 */
import { describe, expect, it } from 'vitest'
import { assertValidOverlayTypes, parseOverlayPayload } from './overlay-wire'
import { EngineTypeError } from './type-expr'
import type { EditOp, OverlayBase, RowId } from '@assay/domain'

/** Test-side branded-id constructor for canonical literal ids. */
const rid = (text: string): RowId => text as RowId

/** The exact payload from the m4-2 review finding 1. */
const REVIEWER_PAYLOAD =
  'VARCHAR) AS "c" FROM (...) ); CREATE TABLE assay_injected AS SELECT 31337; --'

const BASE: OverlayBase = {
  baseAnchor: 'b1',
  overlayAnchor: 'o1',
  columns: [
    { name: 'id', type: 'BIGINT' },
    { name: 'label', type: 'VARCHAR' },
  ],
  baseRowCount: 3,
}

function payload(ops: EditOp[], base: OverlayBase = BASE): unknown {
  return { base, ops }
}

describe('parseOverlayPayload — structure', () => {
  it('parses a valid payload into the domain types', () => {
    const ops: EditOp[] = [
      {
        kind: 'cell-set',
        rowId: rid('base:b1#0'),
        column: 'label',
        value: { kind: 'string', value: 'x' },
      },
      {
        kind: 'row-insert',
        rowId: rid('ins:o1#0'),
        position: { kind: 'start' },
        values: new Map([['id', { kind: 'number', value: 1 }]]),
      },
      { kind: 'row-delete', rowId: rid('base:b1#1') },
      { kind: 'row-restore', rowId: rid('base:b1#1') },
      { kind: 'row-uninsert', rowId: rid('ins:o1#0') },
      { kind: 'cell-revert', rowId: rid('base:b1#0'), column: 'label' },
      { kind: 'column-rename', from: 'label', to: 'label2' },
      { kind: 'column-cast', column: 'id', targetType: 'VARCHAR' },
    ]
    const parsed = parseOverlayPayload(payload(ops))
    expect(parsed).not.toBeNull()
    expect(parsed!.base).toEqual(BASE)
    expect(parsed!.ops).toEqual(ops)
  })

  it('defaults absent ops to an empty list', () => {
    const parsed = parseOverlayPayload({ base: BASE })
    expect(parsed).not.toBeNull()
    expect(parsed!.ops).toEqual([])
  })

  it('rejects non-objects, bad base metadata, and duplicate column names', () => {
    expect(parseOverlayPayload(null)).toBeNull()
    expect(parseOverlayPayload('nope')).toBeNull()
    expect(parseOverlayPayload({ base: { ...BASE, baseRowCount: -1 } })).toBeNull()
    expect(parseOverlayPayload({ base: { ...BASE, baseRowCount: 1.5 } })).toBeNull()
    expect(parseOverlayPayload({ base: { ...BASE, baseAnchor: 42 } })).toBeNull()
    expect(
      parseOverlayPayload({
        base: {
          ...BASE,
          columns: [
            { name: 'a', type: 'BIGINT' },
            { name: 'a', type: 'BIGINT' },
          ],
        },
      }),
    ).toBeNull()
    expect(parseOverlayPayload({ base: { ...BASE, columns: 'nope' } })).toBeNull()
    expect(parseOverlayPayload({ base: { ...BASE, columns: [{ name: 'a' }] } })).toBeNull()
    expect(parseOverlayPayload({ base: BASE, ops: 'nope' })).toBeNull()
  })
})

describe('parseOverlayPayload — cell values and ops', () => {
  it('parses all five cell-value kinds including text and null-as-data', () => {
    const ops: EditOp[] = [
      { kind: 'cell-set', rowId: rid('base:b1#0'), column: 'c', value: { kind: 'null' } },
      {
        kind: 'cell-set',
        rowId: rid('base:b1#0'),
        column: 'c',
        value: { kind: 'boolean', value: true },
      },
      {
        kind: 'cell-set',
        rowId: rid('base:b1#0'),
        column: 'c',
        value: { kind: 'number', value: -1.5 },
      },
      {
        kind: 'cell-set',
        rowId: rid('base:b1#0'),
        column: 'c',
        value: { kind: 'string', value: 's' },
      },
      {
        kind: 'cell-set',
        rowId: rid('base:b1#0'),
        column: 'c',
        value: { kind: 'text', text: '2025-06-30' },
      },
    ]
    const parsed = parseOverlayPayload(payload(ops))
    expect(parsed!.ops).toEqual(ops)
  })

  it('rejects malformed cell values and unknown op kinds', () => {
    const bad: unknown[] = [
      [{ kind: 'cell-set', rowId: rid('base:b1#0'), column: 'c', value: { kind: 'wat' } }],
      [
        {
          kind: 'cell-set',
          rowId: rid('base:b1#0'),
          column: 'c',
          value: { kind: 'number', value: 'x' },
        },
      ],
      [
        {
          kind: 'cell-set',
          rowId: rid('base:b1#0'),
          column: 'c',
          value: { kind: 'text', text: 3 },
        },
      ],
      [{ kind: 'cell-set', rowId: rid('base:b1#0'), value: { kind: 'null' } }],
      [{ kind: 'cell-set', column: 'c', value: { kind: 'null' } }],
      [{ kind: 'wat' }],
      [
        {
          kind: 'row-insert',
          rowId: rid('ins:o1#0'),
          position: { kind: 'start' },
          values: { id: { kind: 'null' } },
        },
      ],
      [
        {
          kind: 'row-insert',
          rowId: rid('ins:o1#0'),
          position: { kind: 'sideways' },
          values: new Map(),
        },
      ],
      [
        {
          kind: 'row-insert',
          rowId: rid('ins:o1#0'),
          position: { kind: 'before' },
          values: new Map(),
        },
      ],
      [{ kind: 'row-delete' }],
      [{ kind: 'column-rename', from: 'a' }],
      [{ kind: 'column-cast', column: 'a', targetType: 3 }],
    ]
    for (const ops of bad) {
      expect(parseOverlayPayload({ base: BASE, ops })).toBeNull()
    }
  })

  it('leaves semantic problems to the fold (typed outcomes, not rejection)', () => {
    // A malformed row id and a foreign anchor parse fine: the fold reports
    // 'malformed-row-id' / 'row-anchor-mismatch' conflicts and the composed
    // view simply never shows them.
    const parsed = parseOverlayPayload({
      base: BASE,
      ops: [
        { kind: 'cell-set', rowId: 'not-a-row-id', column: 'c', value: { kind: 'null' } },
        { kind: 'cell-set', rowId: rid('base:other#0'), column: 'c', value: { kind: 'null' } },
      ],
    })
    expect(parsed).not.toBeNull()
    expect(parsed!.ops).toHaveLength(2)
  })
})

describe('parseOverlayPayload — hostile engine type expressions (m4-2 fix round)', () => {
  it("rejects the reviewer's exact injection payload as a column-cast target", () => {
    const castOverlay = {
      base: BASE,
      ops: [{ kind: 'column-cast' as const, column: 'id', targetType: REVIEWER_PAYLOAD }],
    }
    // Rejected at the boundary (the payload parser's drop contract) …
    expect(parseOverlayPayload(payload(castOverlay.ops))).toBeNull()
    // … and the same validator produces the typed error the client surfaces.
    expect(() => assertValidOverlayTypes(castOverlay)).toThrow(EngineTypeError)
  })

  it('rejects the same payload smuggled through a base column type', () => {
    expect(
      parseOverlayPayload(
        payload([], {
          ...BASE,
          columns: [
            { name: 'id', type: 'BIGINT' },
            { name: 'label', type: REVIEWER_PAYLOAD },
          ],
        }),
      ),
    ).toBeNull()
  })

  it('rejects separators, comments, unbalanced delimiters, and trailing tokens in either position', () => {
    const hostile = [
      "VARCHAR' OR '1'='1",
      'BIGINT; DROP TABLE t',
      'BIGINT -- comment',
      'BIGINT /* comment */',
      'VARCHAR) ', // unbalanced closer
      'VARCHAR extra', // trailing token
      '', // empty
    ]
    for (const type of hostile) {
      expect(
        parseOverlayPayload(payload([{ kind: 'column-cast', column: 'id', targetType: type }])),
        `cast target ${JSON.stringify(type)}`,
      ).toBeNull()
      expect(
        parseOverlayPayload(
          payload([], {
            ...BASE,
            columns: [{ name: 'id', type }],
          }),
        ),
        `base type ${JSON.stringify(type)}`,
      ).toBeNull()
    }
  })

  it('still accepts the benign battery so the validator is not over-restrictive', () => {
    const parsed = parseOverlayPayload(
      payload(
        [
          { kind: 'column-cast', column: 'id', targetType: 'TEXT' },
          { kind: 'column-cast', column: 'label', targetType: 'VARCHAR(20)' },
        ],
        {
          ...BASE,
          columns: [
            { name: 'id', type: 'DECIMAL(10,2)' },
            { name: 'label', type: "ENUM('a','b')" },
          ],
        },
      ),
    )
    expect(parsed).not.toBeNull()
    expect(parsed!.base.columns[0]!.type).toBe('DECIMAL(10,2)')
  })

  it('assertValidOverlayTypes throws the typed EngineTypeError directly', () => {
    expect(() =>
      assertValidOverlayTypes({
        base: { ...BASE, columns: [{ name: 'id', type: REVIEWER_PAYLOAD }] },
      }),
    ).toThrow(EngineTypeError)
    expect(() =>
      assertValidOverlayTypes({
        base: BASE,
        ops: [{ kind: 'column-cast', column: 'id', targetType: REVIEWER_PAYLOAD }],
      }),
    ).toThrow(EngineTypeError)
    expect(() => assertValidOverlayTypes({ base: BASE })).not.toThrow()
  })
})
