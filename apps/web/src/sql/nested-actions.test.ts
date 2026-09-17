import { describe, expect, it } from 'vitest'
import { parseDuckDbType } from '../schema/parseType'
import { composeNestedAction, nestedActionLabel, nestedActionVerb } from './nested-actions'
import type { NestedColumnSpec } from './nested-compose'

/**
 * Pins for the m3-5 action dispatch: the schema tree and grid headers emit a
 * `NestedAction`, and this module must compose it to *exactly* the SQL the
 * m3-4 composer produces (byte-exact pins restated here so a dispatch bug —
 * wrong column, dropped options, mangled path — fails loudly) and to label
 * every action with an accessible name. The composer's own semantics are
 * pinned in `nested-compose.test.ts` (CLI-verified); these pins cover the
 * dispatch layer between the UI surfaces and it.
 */

/** The exact DESCRIBE shape DuckDB 1.5.5 reports for fixtures/jsonl/nested.jsonl
 * (restated from nested-compose.test.ts — the dispatch must compose against the
 * full column list, e.g. for flatten's alias-collision guard). */
const NESTED_JSONL_COLUMNS: readonly NestedColumnSpec[] = [
  { name: 'id', type: parseDuckDbType('BIGINT') },
  { name: 'kind', type: parseDuckDbType('VARCHAR') },
  { name: 'label', type: parseDuckDbType('VARCHAR') },
  { name: 'score', type: parseDuckDbType('BIGINT') },
  { name: 'deep', type: parseDuckDbType('STRUCT(a STRUCT(b STRUCT(c HUGEINT)))') },
  { name: 'meta', type: parseDuckDbType('STRUCT(src VARCHAR, ver BIGINT)') },
  { name: 'tags', type: parseDuckDbType('VARCHAR[]') },
  { name: 'events', type: parseDuckDbType('STRUCT("at" TIMESTAMP, ok BOOLEAN)[]') },
  { name: 'hole', type: parseDuckDbType('JSON') },
  { name: 'weird "quoted" key', type: parseDuckDbType('BIGINT') },
]

describe('composeNestedAction — dispatch to the m3-4 composer', () => {
  it('composes flatten on a struct column to the exact m3-4 SQL', () => {
    expect(
      composeNestedAction('assay_t1', NESTED_JSONL_COLUMNS, { kind: 'flatten', column: 'meta' }),
    ).toEqual({
      ok: true,
      sql:
        'SELECT "id", "kind", "label", "score", "deep", "tags", "events", "hole", ' +
        '"weird ""quoted"" key", ' +
        '"meta"."src" AS "meta.src", "meta"."ver" AS "meta.ver" FROM "assay_t1"',
    })
  })

  it('composes explode on a list column to the exact m3-4 SQL (position included)', () => {
    expect(
      composeNestedAction('assay_t1', NESTED_JSONL_COLUMNS, { kind: 'explode', column: 'tags' }),
    ).toEqual({
      ok: true,
      sql:
        'SELECT "assay_t1"."id", "assay_t1"."kind", "assay_t1"."label", "assay_t1"."score", ' +
        '"assay_t1"."deep", "assay_t1"."meta", "assay_t1"."events", "assay_t1"."hole", ' +
        '"assay_t1"."weird ""quoted"" key", ' +
        '"_assay_explode"."tags" AS "tags", "_assay_explode"."tags.pos" AS "tags.pos" ' +
        'FROM "assay_t1", UNNEST(CASE WHEN "assay_t1"."tags" IS NULL THEN [NULL] ' +
        'ELSE "assay_t1"."tags" END) WITH ORDINALITY AS "_assay_explode"("tags", "tags.pos")',
    })
  })

  it('composes path extraction to the exact m3-4 SQL (struct-only field chain)', () => {
    expect(
      composeNestedAction('assay_t1', NESTED_JSONL_COLUMNS, {
        kind: 'extract',
        path: ['deep', 'a', 'b', 'c'],
      }),
    ).toEqual({
      ok: true,
      sql: `SELECT "deep"['a']['b']['c'] AS "deep.a.b.c" FROM "assay_t1"`,
    })
  })

  it('keeps the hostile fixture key inside identifier context when extracted as a path head', () => {
    expect(
      composeNestedAction('assay_t1', NESTED_JSONL_COLUMNS, {
        kind: 'extract',
        path: ['weird "quoted" key'],
      }),
    ).toEqual({
      ok: true,
      sql: 'SELECT "weird ""quoted"" key" AS "weird ""quoted"" key" FROM "assay_t1"',
    })
  })

  it('surfaces composer rejections as ok:false reasons — never a silent no-op', () => {
    // A UI gating bug could emit an action the composer rejects (e.g. flatten
    // on a zero-field struct root — the one shape the tree gating cannot see
    // past, or a stale action naming a dropped column). The reason must reach
    // the caller so it can render, not vanish.
    const emptyStruct: readonly NestedColumnSpec[] = [
      { name: 'e', type: parseDuckDbType('STRUCT()') },
    ]
    expect(composeNestedAction('assay_t1', emptyStruct, { kind: 'flatten', column: 'e' })).toEqual({
      ok: false,
      reason: 'column "e" has no fields to flatten',
    })

    expect(
      composeNestedAction('assay_t1', NESTED_JSONL_COLUMNS, {
        kind: 'flatten',
        column: 'dropped',
      }).ok,
    ).toBe(false)
    expect(
      composeNestedAction('assay_t1', NESTED_JSONL_COLUMNS, { kind: 'explode', column: 'meta' }).ok,
    ).toBe(false)
    expect(
      composeNestedAction('assay_t1', NESTED_JSONL_COLUMNS, { kind: 'extract', path: [] }).ok,
    ).toBe(false)
  })
})

describe('action labels — accessible names and visible verbs', () => {
  it('announces operation and target', () => {
    expect(nestedActionLabel({ kind: 'flatten', column: 'meta' })).toBe(
      'Flatten struct column meta',
    )
    expect(nestedActionLabel({ kind: 'explode', column: 'tags' })).toBe('Explode list column tags')
    expect(nestedActionLabel({ kind: 'extract', path: ['deep', 'a', 'b', 'c'] })).toBe(
      'Extract path deep.a.b.c',
    )
  })

  it('renders short visible verbs', () => {
    expect(nestedActionVerb({ kind: 'flatten', column: 'meta' })).toBe('Flatten')
    expect(nestedActionVerb({ kind: 'explode', column: 'tags' })).toBe('Explode')
    expect(nestedActionVerb({ kind: 'extract', path: ['meta', 'src'] })).toBe('Extract path')
  })

  it('labels stay text: hostile names render verbatim, never interpreted', () => {
    // Untrusted field names flow into labels as *content* (rendered as text
    // by React interpolation) — pinned so nobody "escapes" them into markup.
    expect(nestedActionLabel({ kind: 'extract', path: ['meta', 'weird ]key['] })).toBe(
      'Extract path meta.weird ]key[',
    )
  })
})
