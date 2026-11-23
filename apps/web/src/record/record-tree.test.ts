// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { parseDuckDbType } from '../schema/parseType'
import { formatNestedPreview } from '../grid/nested-preview'
import {
  buildRecordTree,
  collectBranchPaths,
  RECORD_TREE_DEFAULT_MAX_CHILDREN,
  RECORD_TREE_DEFAULT_MAX_DEPTH,
  RECORD_TREE_EXPANDED_MAX_CHILDREN,
  treeHasTruncation,
} from './record-tree'
import type { RecordTreeNode } from './record-tree'

/**
 * m3-3 unit tests for the record tree model. The pinned fixture expectations
 * mirror the m3-1 worker-boundary contract (@assay/testing's
 * `normalizeArrowCell` scenarios over `fixtures/jsonl/nested.jsonl`): structs
 * arrive as records in field order, lists as arrays / `{length, get}` slices,
 * 64-bit integers as bigint, timestamps as epoch-ms numbers, NULL as `null`.
 */

/** Child keys of a node, in order. */
function keysOf(node: RecordTreeNode): string[] {
  return node.children.map((child) => child.key)
}

/** Finds one child by key (tests address nodes by delivered key). */
function child(node: RecordTreeNode, key: string): RecordTreeNode {
  const found = node.children.find((candidate) => candidate.key === key)
  if (found === undefined) throw new Error(`no child keyed ${key}`)
  return found
}

/** A grid row shaped like nested.jsonl row id 1 through the Arrow boundary. */
function rowId1(): { columns: string[]; cells: unknown[] } {
  return {
    columns: [
      'id',
      'kind',
      'label',
      'score',
      'deep',
      'meta',
      'tags',
      'events',
      'hole',
      'weird "quoted" key',
    ],
    cells: [
      1n,
      'alpha',
      'plain alpha row',
      10n,
      { a: { b: { c: 1n } } },
      { src: 'sensor-a', ver: 1n },
      ['x', 'y'],
      [
        { at: 1740823200000, ok: true },
        { at: 1740823500000, ok: false },
      ],
      null,
      1n,
    ],
  }
}

describe('buildRecordTree — shape and ordering', () => {
  it('keys root children by schema column order, not cell or alphabetic order', () => {
    const tree = buildRecordTree({ columns: ['z', 'm', 'a'], cells: [1n, 2n, 3n] })
    expect(tree.kind).toBe('object')
    expect(keysOf(tree)).toEqual(['z', 'm', 'a'])
  })

  it('classifies structs as objects in the delivered own-key order (never re-sorted)', () => {
    const tree = buildRecordTree({ columns: ['meta'], cells: [{ ver: 1n, src: 's' }] })
    const meta = child(tree, 'meta')
    expect(meta.kind).toBe('object')
    expect(keysOf(meta)).toEqual(['ver', 'src']) // delivered order, not alphabetical
  })

  it('classifies arrays and Arrow list slices as arrays with positional keys', () => {
    const plain = buildRecordTree({ columns: ['tags'], cells: [['x', 'y']] })
    const tags = child(plain, 'tags')
    expect(tags.kind).toBe('array')
    expect(keysOf(tags)).toEqual(['0', '1'])
    // The Arrow slice shape: numeric length + positional get.
    const slice = { length: 2, get: (index: number) => ['x', 'y'][index] }
    const viaSlice = buildRecordTree({ columns: ['tags'], cells: [slice] })
    expect(child(viaSlice, 'tags').kind).toBe('array')
    expect(keysOf(child(viaSlice, 'tags'))).toEqual(['0', '1'])
    expect(child(child(viaSlice, 'tags'), '1').summary).toBe('"y"')
  })

  it('traverses sparse arrays positionally — holes surface as undefined leaves', () => {
    const sparse: string[] = ['x']
    sparse[2] = 'z'
    const tree = buildRecordTree({ columns: ['tags'], cells: [sparse] })
    const tags = child(tree, 'tags')
    expect(keysOf(tags)).toEqual(['0', '1', '2'])
    expect(child(tags, '1')).toMatchObject({ kind: 'leaf', summary: 'undefined' })
  })

  it('keeps duplicate column names as two children (keys are data, not identity)', () => {
    const tree = buildRecordTree({ columns: ['id', 'id'], cells: [1n, 2n] })
    expect(keysOf(tree)).toEqual(['id', 'id'])
    expect(tree.children.map((node) => node.summary)).toEqual(['1', '2'])
  })

  it('ignores extra cells beyond the schema (unnamed data cannot render honestly)', () => {
    const tree = buildRecordTree({ columns: ['id'], cells: [1n, 'surplus'] })
    expect(keysOf(tree)).toEqual(['id'])
  })

  it('renders an empty row as an empty root', () => {
    expect(buildRecordTree({ columns: [], cells: [] }).children).toEqual([])
  })
})

describe('buildRecordTree — honest value distinctions (nested.jsonl contract)', () => {
  it('distinguishes NULL vs empty string vs empty list vs empty object', () => {
    const tree = buildRecordTree({
      columns: ['n', 's', 'l', 'o'],
      cells: [null, '', [], {}],
    })
    expect(child(tree, 'n')).toMatchObject({ kind: 'null', summary: 'null', children: [] })
    expect(child(tree, 's')).toMatchObject({ kind: 'leaf', summary: '""', children: [] })
    expect(child(tree, 'l')).toMatchObject({ kind: 'array', summary: '[]', children: [] })
    expect(child(tree, 'o')).toMatchObject({ kind: 'object', summary: '{}', children: [] })
  })

  it('renders 64-bit integers as number-strings (bigint cells)', () => {
    const tree = buildRecordTree({ columns: ['id', 'score'], cells: [1n, -9n] })
    expect(child(tree, 'id')).toMatchObject({ kind: 'leaf', summary: '1' })
    expect(child(tree, 'score')).toMatchObject({ kind: 'leaf', summary: '-9' })
  })

  it('renders epoch-ms timestamps as plain numbers (m3-1 worker-boundary contract)', () => {
    const tree = buildRecordTree({
      columns: ['events'],
      cells: [[{ at: 1740823200000, ok: true }]],
    })
    const at = child(child(child(tree, 'events'), '0'), 'at')
    expect(at).toMatchObject({ kind: 'leaf', summary: '1740823200000' })
  })

  it('summarizes binary views as byte counts, never a byte dump', () => {
    const tree = buildRecordTree({ columns: ['blob'], cells: [new Uint8Array([1, 2, 3])] })
    expect(child(tree, 'blob')).toMatchObject({ kind: 'leaf', summary: '<3 bytes>' })
  })

  it('renders Dates as quoted ISO leaves (defensive: the transport does not deliver them)', () => {
    const tree = buildRecordTree({ columns: ['when'], cells: [new Date('2025-03-01T10:00:00Z')] })
    expect(child(tree, 'when')).toMatchObject({
      kind: 'leaf',
      summary: '"2025-03-01T10:00:00.000Z"',
    })
  })

  it('keeps undefined (missing cell) a leaf distinct from null', () => {
    const tree = buildRecordTree({ columns: ['x'], cells: [] })
    expect(child(tree, 'x')).toMatchObject({ kind: 'leaf', summary: 'undefined' })
  })
})

describe('buildRecordTree — full depth beyond the preview cap', () => {
  it('carries depth-3+ leaves the capped preview elides', () => {
    const tree = buildRecordTree(rowId1())
    const c = child(child(child(child(tree, 'deep'), 'a'), 'b'), 'c')
    expect(c).toMatchObject({ kind: 'leaf', summary: '1' })
    // The summary of `deep` is still the capped preview (bounded collapse view).
    expect(child(tree, 'deep').summary).toBe('{"a":{"b":{"c":…}}}')
  })

  it('renders the quoting-hostile key verbatim as data', () => {
    const tree = buildRecordTree(rowId1())
    expect(keysOf(tree)[9]).toBe('weird "quoted" key')
    expect(child(tree, 'weird "quoted" key')).toMatchObject({ kind: 'leaf', summary: '1' })
  })

  it('preserves NULLs at depth: NULL struct field, NULL leaf, NULL list element, NULL element', () => {
    const tree = buildRecordTree({
      columns: ['deep', 'meta', 'tags', 'events'],
      cells: [
        { a: { b: { c: null } } },
        { src: null, ver: 3n },
        ['x', null, 'z'],
        [{ at: null, ok: true }, null],
      ],
    })
    expect(child(child(child(child(tree, 'deep'), 'a'), 'b'), 'c')).toMatchObject({
      kind: 'null',
      summary: 'null',
    })
    expect(child(child(tree, 'meta'), 'src')).toMatchObject({ kind: 'null', summary: 'null' })
    expect(child(child(tree, 'tags'), '1')).toMatchObject({ kind: 'null', summary: 'null' })
    expect(child(child(child(tree, 'events'), '0'), 'at')).toMatchObject({
      kind: 'null',
      summary: 'null',
    })
    expect(child(tree, 'events').children[1]).toMatchObject({ kind: 'null', children: [] })
  })

  it('classifies whole-NULL containers as null nodes without children', () => {
    const tree = buildRecordTree({ columns: ['deep', 'tags'], cells: [null, null] })
    expect(child(tree, 'deep')).toMatchObject({ kind: 'null', summary: 'null', children: [] })
    expect(child(tree, 'tags')).toMatchObject({ kind: 'null', summary: 'null', children: [] })
  })
})

describe('buildRecordTree — totality under hostile input', () => {
  it('never throws on a cyclic value: the re-entered container becomes a marked leaf', () => {
    const hostile: Record<string, unknown> = { name: 'loop' }
    hostile['self'] = hostile
    const tree = buildRecordTree({ columns: ['hostile'], cells: [hostile] })
    const node = child(tree, 'hostile')
    expect(node.kind).toBe('object')
    expect(child(node, 'self')).toMatchObject({ kind: 'leaf', summary: '(circular)', children: [] })
  })

  it('degrades one throwing getter to a marked leaf without sinking its siblings', () => {
    const hostile = {
      get boom(): string {
        throw new Error('hostile getter')
      },
      fine: 'ok',
    }
    const tree = buildRecordTree({ columns: ['hostile'], cells: [hostile] })
    const node = child(tree, 'hostile')
    expect(keysOf(node)).toEqual(['boom', 'fine'])
    expect(child(node, 'boom')).toMatchObject({ kind: 'leaf', summary: '(unreadable)' })
    expect(child(node, 'fine')).toMatchObject({ kind: 'leaf', summary: '"ok"' })
  })

  it('survives a list whose positional getter throws', () => {
    const hostileSlice = {
      length: 2,
      get(index: number): unknown {
        if (index === 1) throw new Error('hostile get')
        return 'x'
      },
    }
    const tree = buildRecordTree({ columns: ['tags'], cells: [hostileSlice] })
    const tags = child(tree, 'tags')
    expect(tags.kind).toBe('array')
    expect(child(tags, '0').summary).toBe('"x"')
    expect(child(tags, '1')).toMatchObject({ kind: 'leaf', summary: '(unreadable)' })
  })

  it('survives a proxy whose ownKeys trap throws', () => {
    const proxy = new Proxy(
      {},
      {
        ownKeys(): readonly string[] {
          throw new Error('hostile ownKeys')
        },
        getOwnPropertyDescriptor(): PropertyDescriptor | undefined {
          return { configurable: true, enumerable: true }
        },
        get(): unknown {
          return 1n
        },
      },
    )
    const tree = buildRecordTree({ columns: ['p'], cells: [proxy] })
    expect(child(tree, 'p')).toMatchObject({ kind: 'leaf', summary: '(unreadable)', children: [] })
  })

  it('is total across a seeded sweep of hostile shapes', () => {
    const shapes: unknown[] = [
      undefined,
      null,
      NaN,
      Infinity,
      -0,
      2n ** 64n,
      '',
      new Map([[1, 2]]),
      new Set([1]),
      /regex/,
      Symbol('s'),
      () => 'function',
      { length: 'not-a-number', get: () => null },
      { length: -1, get: () => null },
      [1, [2, [3, [4, [5]]]]],
      { toJSON: () => ({ x: 1 }) },
    ]
    for (const [index, shape] of shapes.entries()) {
      expect(() =>
        buildRecordTree({ columns: [`c${String(index)}`], cells: [shape] }),
      ).not.toThrow()
    }
  })
})

describe('buildRecordTree — determinism and summary reuse', () => {
  it('builds the identical tree for identical input', () => {
    expect(JSON.stringify(buildRecordTree(rowId1()))).toBe(
      JSON.stringify(buildRecordTree(rowId1())),
    )
  })

  it('summaries are formatNestedPreview renders — reuse, not a fork', () => {
    const tree = buildRecordTree(rowId1())
    for (const node of [child(tree, 'deep'), child(tree, 'tags'), child(tree, 'hole')]) {
      const value = rowId1().cells[rowId1().columns.indexOf(node.key)]
      expect(node.summary).toBe(formatNestedPreview(value))
    }
  })
})

describe('collectBranchPaths — expand-all affordance geometry', () => {
  it('lists every object/array path in render order, using the component path scheme', () => {
    const paths = collectBranchPaths(buildRecordTree(rowId1()))
    expect(paths).toEqual([
      'deep',
      'deep/a',
      'deep/a/b',
      'meta',
      'tags',
      'events',
      'events/0',
      'events/1',
    ])
  })

  it('returns empty for an all-leaf row and includes empty containers as leaves-to-be', () => {
    expect(collectBranchPaths(buildRecordTree({ columns: ['id'], cells: [1n] }))).toEqual([])
    // Empty containers are branches (renderable, expandable — their children list is just empty).
    const paths = collectBranchPaths(buildRecordTree({ columns: ['l', 'o'], cells: [[], {}] }))
    expect(paths).toEqual(['l', 'o'])
  })
})

/** Total node count (the bound AR-W8 makes structural). */
function countNodes(node: RecordTreeNode): number {
  let total = 1
  for (const childNode of node.children) total += countNodes(childNode)
  return total
}

describe('buildRecordTree — AR-W8 length and depth caps', () => {
  it('caps a large list, records the omitted count, and bounds the node count', () => {
    const big = Array.from({ length: 500 }, (_, index) => index)
    const tree = buildRecordTree({ columns: ['big'], cells: [big] })
    const node = child(tree, 'big')
    expect(node.children).toHaveLength(RECORD_TREE_DEFAULT_MAX_CHILDREN)
    expect(node.omittedChildren).toBe(500 - RECORD_TREE_DEFAULT_MAX_CHILDREN)
    // One root + one container + capped children; never the full 500.
    expect(countNodes(tree)).toBe(2 + RECORD_TREE_DEFAULT_MAX_CHILDREN)
    expect(treeHasTruncation(tree)).toBe(true)
  })

  it('caps a wide record with the same discipline', () => {
    const record: Record<string, number> = {}
    for (let index = 0; index < 300; index++) record[`k${String(index)}`] = index
    const tree = buildRecordTree({ columns: ['rec'], cells: [record] })
    const node = child(tree, 'rec')
    expect(node.children).toHaveLength(RECORD_TREE_DEFAULT_MAX_CHILDREN)
    expect(node.omittedChildren).toBe(300 - RECORD_TREE_DEFAULT_MAX_CHILDREN)
  })

  it('caps a deep chain and marks the node depthCapped (not empty)', () => {
    let deep: unknown = 'leaf'
    for (let index = 0; index < RECORD_TREE_DEFAULT_MAX_DEPTH + 3; index++) {
      deep = { next: deep }
    }
    const tree = buildRecordTree({ columns: ['deep'], cells: [deep] })
    let node = child(tree, 'deep')
    let depth = 1
    while (node.children.length > 0) {
      node = node.children[0]!
      depth += 1
    }
    expect(node.depthCapped).toBe(true)
    expect(node.children).toEqual([])
    expect(depth).toBe(RECORD_TREE_DEFAULT_MAX_DEPTH)
    expect(treeHasTruncation(tree)).toBe(true)
  })

  it('honest markers only: small values are uncapped and report no truncation', () => {
    expect(treeHasTruncation(buildRecordTree(rowId1()))).toBe(false)
    expect(treeHasTruncation(buildRecordTree({ columns: ['id'], cells: [1n] }))).toBe(false)
  })

  it('the expanded caps are progressive disclosure, not data loss', () => {
    const big = Array.from({ length: 500 }, (_, index) => index)
    const expanded = buildRecordTree(
      { columns: ['big'], cells: [big] },
      { maxChildren: RECORD_TREE_EXPANDED_MAX_CHILDREN },
    )
    const node = child(expanded, 'big')
    expect(node.children).toHaveLength(500)
    expect(node.omittedChildren).toBeUndefined()
    expect(treeHasTruncation(expanded)).toBe(false)
  })
})

// ---- R-13: per-column parsed types for nested `UHUGEINT` summaries ----
//
// The Record inspector is the full-value layer, so an optional `columnTypes`
// channel (the m4-5 per-column pattern) lets each node's summary decode a
// declared `UHUGEINT`/decimal leaf exactly. Every fail-soft case — absent type,
// non-`UHUGEINT` type, wrong-width payload — keeps today's `<N bytes>`.

/** A 16-byte little-endian **unsigned** payload (Arrow `FixedSizeBinary(16)`). */
function uhugeintBytes(value: bigint): Uint8Array {
  const bytes = new Uint8Array(16)
  let rest = value
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number(rest & 0xffn)
    rest >>= 8n
  }
  return bytes
}

/** 2^64 — above the signed 64-bit range, so the digits prove the unsigned decode. */
const TWO_TO_64 = 18446744073709551616n

describe('buildRecordTree — nested UHUGEINT summaries via column types (R-13)', () => {
  it('shows the exact value in the struct summary and its nested leaf', () => {
    const tree = buildRecordTree({
      columns: ['meta'],
      cells: [{ big: uhugeintBytes(TWO_TO_64) }],
      columnTypes: [parseDuckDbType('STRUCT("big" UHUGEINT)')],
    })
    expect(child(tree, 'meta')).toMatchObject({
      kind: 'object',
      summary: '{"big":18446744073709551616}',
    })
    expect(child(child(tree, 'meta'), 'big')).toMatchObject({
      kind: 'leaf',
      summary: '18446744073709551616',
    })
  })

  it('shows the exact value for list elements and a list-of-struct field', () => {
    const list = buildRecordTree({
      columns: ['bigs'],
      cells: [[uhugeintBytes(TWO_TO_64), uhugeintBytes(0n)]],
      columnTypes: [parseDuckDbType('UHUGEINT[]')],
    })
    expect(child(list, 'bigs').summary).toBe('[18446744073709551616,0]')
    expect(child(child(list, 'bigs'), '0')).toMatchObject({
      kind: 'leaf',
      summary: '18446744073709551616',
    })
    const nested = buildRecordTree({
      columns: ['rows'],
      cells: [[{ big: uhugeintBytes(TWO_TO_64) }]],
      columnTypes: [parseDuckDbType('STRUCT("big" UHUGEINT)[]')],
    })
    expect(child(child(child(nested, 'rows'), '0'), 'big')).toMatchObject({
      kind: 'leaf',
      summary: '18446744073709551616',
    })
  })

  it('keeps today’s <N bytes> summaries when no column types are supplied', () => {
    const tree = buildRecordTree({
      columns: ['meta', 'blob'],
      cells: [{ big: uhugeintBytes(TWO_TO_64) }, new Uint8Array(16)],
    })
    expect(child(tree, 'meta').summary).toBe('{"big":<16 bytes>}')
    expect(child(child(tree, 'meta'), 'big')).toMatchObject({ summary: '<16 bytes>' })
    expect(child(tree, 'blob')).toMatchObject({ kind: 'leaf', summary: '<16 bytes>' })
  })

  it('keeps the honest summary for a BLOB(16) column', () => {
    const tree = buildRecordTree({
      columns: ['b'],
      cells: [new Uint8Array(16).fill(7)],
      columnTypes: [parseDuckDbType('BLOB')],
    })
    expect(child(tree, 'b')).toMatchObject({ kind: 'leaf', summary: '<16 bytes>' })
  })

  it('keeps the summary for a wrong-width payload at a UHUGEINT position', () => {
    const tree = buildRecordTree({
      columns: ['meta'],
      cells: [{ big: new Uint8Array(8) }],
      columnTypes: [parseDuckDbType('STRUCT("big" UHUGEINT)')],
    })
    expect(child(tree, 'meta').summary).toBe('{"big":<8 bytes>}')
    expect(child(child(tree, 'meta'), 'big')).toMatchObject({ summary: '<8 bytes>' })
  })

  it('treats a missing columnTypes entry as type-blind', () => {
    const tree = buildRecordTree({
      columns: ['meta', 'other'],
      cells: [{ big: uhugeintBytes(TWO_TO_64) }, { big: uhugeintBytes(TWO_TO_64) }],
      columnTypes: [parseDuckDbType('STRUCT("big" UHUGEINT)')],
    })
    expect(child(tree, 'meta').summary).toBe('{"big":18446744073709551616}')
    expect(child(tree, 'other').summary).toBe('{"big":<16 bytes>}')
  })
})
