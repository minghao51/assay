import { describe, expect, it } from 'vitest'
import { quotedIdentifier } from '@assay/engine-duckdb'
import type { DuckDbType } from '../schema/parseType'
import { parseDuckDbType } from '../schema/parseType'
import { explodeColumnSql, flattenColumnSql, pathExtractSql } from './nested-compose'
import type { NestedColumnSpec } from './nested-compose'

/**
 * Pins for the m3-4 nested SQL composer. The exact SQL strings below are
 * byte-exact: the explode/flatten/path shapes they pin are the same shapes
 * executed against the DuckDB CLI (v1.5.5, the repo's pinning toolchain) on
 * `fixtures/jsonl/nested.jsonl` — each CLI-verified pin quotes the executed
 * query and the recorded output in its comment.
 *
 * Invariants under test (see nested-compose.ts module comment for the full
 * semantics record):
 * - every identifier passes `quotedIdentifier` (engine export), every path
 *   field name passes single-quote doubling — hostile names never escape
 *   identifier/literal context;
 * - explode keeps NULL-list rows as one NULL element, drops empty lists to
 *   zero rows, and exposes a 1-based position column;
 * - degenerate inputs (missing/degenerate columns, collisions) error
 *   honestly instead of composing degenerate SQL.
 */

/** The exact DESCRIBE shape DuckDB 1.5.5 reports for fixtures/jsonl/nested.jsonl. */
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

describe('quotedIdentifier — the engine export the composer quotes through', () => {
  it('is the engine implementation, pinned against the fixture hostile key', () => {
    // Consumption pin (m2-7/m3-0 style): nested-compose imports this symbol
    // from `@assay/engine-duckdb`, so the quoting the composer emits IS the
    // engine's quoting — there is no local mirror to drift. The engine-side
    // pins live in engine-duckdb format-view.test.ts.
    expect(quotedIdentifier('weird "quoted" key')).toBe('"weird ""quoted"" key"')
    expect(quotedIdentifier('has "quote"')).toBe('"has ""quote"""')
  })
})

describe('flattenColumnSql — STRUCT column replaced by quoted dotted child columns', () => {
  it('composes other columns plus one aliased field per struct field (fixture meta)', () => {
    // CLI (1.5.5), fixtures/jsonl/nested.jsonl — same shape, aliased dotted
    // aliases survive as single columns:
    //   SELECT v.id, v."meta"."src" AS "meta.src", v."meta"."ver" AS "meta.ver"
    //   FROM v WHERE v.id IN (1,3,5) ORDER BY v.id;
    //   ┌────┬──────────┬──────────┐
    //   │ id │ meta.src │ meta.ver │
    //   ├────┼──────────┼──────────┤
    //   │ 1  │ sensor-a │ 1        │
    //   │ 3  │ NULL     │ 3        │  ← NULL field stays NULL
    //   │ 5  │ NULL     │ NULL     │  ← NULL struct flattens to NULLs
    //   └────┴──────────┴──────────┘
    expect(flattenColumnSql('assay_t1', NESTED_JSONL_COLUMNS, 'meta')).toEqual({
      ok: true,
      sql:
        'SELECT "id", "kind", "label", "score", "deep", "tags", "events", "hole", ' +
        '"weird ""quoted"" key", ' +
        '"meta"."src" AS "meta.src", "meta"."ver" AS "meta.ver" FROM "assay_t1"',
    })
  })

  it('flattens the depth-3 struct column in field order', () => {
    expect(flattenColumnSql('assay_t1', NESTED_JSONL_COLUMNS, 'deep')).toEqual({
      ok: true,
      sql:
        'SELECT "id", "kind", "label", "score", "meta", "tags", "events", "hole", ' +
        '"weird ""quoted"" key", "deep"."a" AS "deep.a" FROM "assay_t1"',
    })
  })

  it('escapes hostile struct field names inside identifier context', () => {
    // parseDuckDbType unquotes `""` doublings, the composer re-quotes them.
    const hostile = parseDuckDbType('STRUCT("weird ""f"" name" INTEGER, "a\'\'b" VARCHAR)')
    const columns: NestedColumnSpec[] = [{ name: 's', type: hostile }]
    expect(flattenColumnSql('assay_t9', columns, 's')).toEqual({
      ok: true,
      sql:
        'SELECT "s"."weird ""f"" name" AS "s.weird ""f"" name", ' +
        '"s"."a\'\'b" AS "s.a\'\'b" FROM "assay_t9"',
    })
  })

  it('rejects degenerate columns with honest reasons', () => {
    expect(flattenColumnSql('', NESTED_JSONL_COLUMNS, 'meta')).toEqual({
      ok: false,
      reason: 'viewName must be a non-empty string',
    })
    expect(flattenColumnSql('assay_t1', NESTED_JSONL_COLUMNS, 'missing').ok).toBe(false)
    expect(flattenColumnSql('assay_t1', NESTED_JSONL_COLUMNS, 'tags')).toEqual({
      ok: false,
      reason: 'column "tags" is not a STRUCT column',
    })
    expect(flattenColumnSql('assay_t1', NESTED_JSONL_COLUMNS, 'hole')).toEqual({
      ok: false,
      reason: 'column "hole" is not a STRUCT column',
    })
    const unionColumns: NestedColumnSpec[] = [
      { name: 'u', type: parseDuckDbType('UNION(a INTEGER)') },
    ]
    expect(flattenColumnSql('assay_t1', unionColumns, 'u')).toEqual({
      ok: false,
      reason: 'column "u" is a UNION type; only STRUCT columns can be flattened',
    })
    const emptyStruct: NestedColumnSpec[] = [{ name: 'e', type: parseDuckDbType('STRUCT()') }]
    expect(flattenColumnSql('assay_t1', emptyStruct, 'e')).toEqual({
      ok: false,
      reason: 'column "e" has no fields to flatten',
    })
  })

  it('refuses to emit a dotted alias that collides with an existing column', () => {
    // Hostile schema: a scalar column literally named "meta.src".
    const colliding: NestedColumnSpec[] = [
      { name: 'meta.src', type: parseDuckDbType('VARCHAR') },
      { name: 'meta', type: parseDuckDbType('STRUCT(src VARCHAR)') },
    ]
    expect(flattenColumnSql('assay_t1', colliding, 'meta').ok).toBe(false)
  })
})

describe('explodeColumnSql — LIST column to rows WITH ORDINALITY', () => {
  it('composes other columns (view-qualified) plus element and 1-based position', () => {
    // CLI (1.5.5), fixtures/jsonl/nested.jsonl — the composed shape, executed:
    //   SELECT v.id, u.tags, u."tags.pos"
    //   FROM v, UNNEST(CASE WHEN v.tags IS NULL THEN [NULL] ELSE v.tags END)
    //     WITH ORDINALITY AS u(tags, "tags.pos")
    //   WHERE v.id IN (1,2,3,4,9) ORDER BY v.id, u."tags.pos";
    //   ┌────┬──────┬──────────┐
    //   │ id │ tags │ tags.pos │
    //   ├────┼──────┼──────────┤
    //   │ 1  │ x    │ 1        │
    //   │ 1  │ y    │ 2        │
    //   │ 3  │ x    │ 1        │
    //   │ 3  │ NULL │ 2        │  ← NULL element kept, position honest
    //   │ 3  │ z    │ 3        │
    //   │ 4  │ NULL │ 1        │  ← NULL LIST → one NULL row (kept!)
    //   └────┴──────┴──────────┘
    // id 2/9 (EMPTY lists) produce zero rows — true cardinality. Without the
    // CASE guard the bare UNNEST also drops the NULL-list rows (verified:
    // id 4 vanished entirely), silently losing the parent row.
    expect(explodeColumnSql('assay_t1', NESTED_JSONL_COLUMNS, 'tags')).toEqual({
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

  it('omits the position column and WITH ORDINALITY when withPosition is false', () => {
    const composed = explodeColumnSql('assay_t1', NESTED_JSONL_COLUMNS, 'tags', {
      withPosition: false,
    })
    expect(composed).toEqual({
      ok: true,
      sql:
        'SELECT "assay_t1"."id", "assay_t1"."kind", "assay_t1"."label", "assay_t1"."score", ' +
        '"assay_t1"."deep", "assay_t1"."meta", "assay_t1"."events", "assay_t1"."hole", ' +
        '"assay_t1"."weird ""quoted"" key", "_assay_explode"."tags" AS "tags" ' +
        'FROM "assay_t1", UNNEST(CASE WHEN "assay_t1"."tags" IS NULL THEN [NULL] ' +
        'ELSE "assay_t1"."tags" END) AS "_assay_explode"("tags")',
    })
  })

  it('explodes list-of-structs with fields reachable through the element alias', () => {
    // CLI (1.5.5), fixture events column (STRUCT("at" TIMESTAMP, ok BOOLEAN)[]):
    //   SELECT v.id, u.ev.at, u.ev.ok FROM v,
    //     UNNEST(CASE WHEN v.events IS NULL THEN [NULL] ELSE v.events END)
    //       WITH ORDINALITY AS u(ev, p) WHERE v.id IN (1,4) ORDER BY v.id, p;
    //   ┌────┬─────────────────────┬───────┐
    //   │ id │         at          │  ok   │
    //   ├────┼─────────────────────┼───────┤
    //   │ 1  │ 2025-03-01 10:00:00 │ true  │
    //   │ 1  │ 2025-03-01 10:05:00 │ false │
    //   │ 4  │ 2025-03-04 07:00:00 │ false │
    //   │ 4  │ NULL                │ NULL  │  ← NULL element: row kept, fields NULL
    //   └────┴─────────────────────┴───────┘
    // (id 10, whole-NULL list → one NULL row; recorded in the module comment.)
    expect(explodeColumnSql('assay_t1', NESTED_JSONL_COLUMNS, 'events')).toEqual({
      ok: true,
      sql:
        'SELECT "assay_t1"."id", "assay_t1"."kind", "assay_t1"."label", "assay_t1"."score", ' +
        '"assay_t1"."deep", "assay_t1"."meta", "assay_t1"."tags", "assay_t1"."hole", ' +
        '"assay_t1"."weird ""quoted"" key", ' +
        '"_assay_explode"."events" AS "events", "_assay_explode"."events.pos" AS "events.pos" ' +
        'FROM "assay_t1", UNNEST(CASE WHEN "assay_t1"."events" IS NULL THEN [NULL] ' +
        'ELSE "assay_t1"."events" END) WITH ORDINALITY AS "_assay_explode"("events", "events.pos")',
    })
  })

  it('rejects degenerate columns with honest reasons', () => {
    expect(explodeColumnSql('', NESTED_JSONL_COLUMNS, 'tags')).toEqual({
      ok: false,
      reason: 'viewName must be a non-empty string',
    })
    expect(explodeColumnSql('assay_t1', NESTED_JSONL_COLUMNS, 'missing').ok).toBe(false)
    expect(explodeColumnSql('assay_t1', NESTED_JSONL_COLUMNS, 'meta')).toEqual({
      ok: false,
      reason: 'column "meta" is not a LIST column',
    })
    // CLI: FROM-clause UNNEST on a fixed-size array answers
    //   "Binder Error: UNNEST requires a single list as input"
    // (SELECT-list unnest happens to accept them — the composer errors
    // instead of emitting construct-dependent SQL).
    const fixed: NestedColumnSpec[] = [{ name: 'grid', type: parseDuckDbType('DECIMAL(21,1)[3]') }]
    expect(explodeColumnSql('assay_t1', fixed, 'grid')).toEqual({
      ok: false,
      reason: 'column "grid" is a fixed-size array ([3]); DuckDB UNNEST cannot explode it',
    })
  })

  it('refuses to emit a position column that collides with an existing column', () => {
    // Hostile schema: a scalar column literally named "tags.pos".
    const colliding: NestedColumnSpec[] = [
      { name: 'tags.pos', type: parseDuckDbType('VARCHAR') },
      { name: 'tags', type: parseDuckDbType('VARCHAR[]') },
    ]
    expect(explodeColumnSql('assay_t1', colliding, 'tags').ok).toBe(false)
  })
})

describe('pathExtractSql — bracket paths with escaped literals and 1-based emitted indices', () => {
  it('composes struct field paths with dotted aliases', () => {
    // CLI (1.5.5), fixture: SELECT v."meta"['src'] FROM v WHERE v.id = 1
    //   → sensor-a. Whole-NULL structs read as NULL (id 5 → NULL, recorded in
    //   the flatten comment); a missing key is a loud engine binder error
    //   ("Could not find key "nope" in struct" — verified).
    expect(pathExtractSql('assay_t1', ['meta', 'src'])).toEqual({
      ok: true,
      sql: `SELECT "meta"['src'] AS "meta.src" FROM "assay_t1"`,
    })
    expect(pathExtractSql('assay_t1', ['deep', 'a', 'b', 'c'])).toEqual({
      ok: true,
      sql: `SELECT "deep"['a']['b']['c'] AS "deep.a.b.c" FROM "assay_t1"`,
    })
  })

  it('converts app-side 0-based indices to DuckDB 1-based and mirrors them in the alias', () => {
    // CLI (1.5.5): [10,20,30][0] → NULL, [10,20,30][1] → 10, [10,20,30][-1] → 30
    // (DuckDB list indexing is 1-based, out-of-bounds reads NULL; negative
    // indices mean "from the end", which is why the composer validates
    // non-negative input instead of passing negatives through).
    // Fixture: SELECT v."tags"[1], v."tags"[2] FROM v WHERE v.id = 1 → x, y.
    expect(pathExtractSql('assay_t1', ['tags', 0])).toEqual({
      ok: true,
      sql: `SELECT "tags"[1] AS "tags[1]" FROM "assay_t1"`,
    })
    // CLI (1.5.5), fixture mixed path:
    //   SELECT v."events"[1]['at'], v."events"[2]['ok'] FROM v WHERE v.id = 1
    //   → 2025-03-01 10:00:00, false.
    expect(pathExtractSql('assay_t1', ['events', 1, 'ok'])).toEqual({
      ok: true,
      sql: `SELECT "events"[2]['ok'] AS "events[2].ok" FROM "assay_t1"`,
    })
    // Out-of-bounds composes (NULL read, verified: v."events"[99]['at'] → NULL).
    expect(pathExtractSql('assay_t1', ['events', 99, 'at'])).toEqual({
      ok: true,
      sql: `SELECT "events"[100]['at'] AS "events[100].at" FROM "assay_t1"`,
    })
  })

  it('keeps hostile names inside identifier and literal context (exact composed SQL)', () => {
    // (a) The fixture's hostile key as the path head — identifier context:
    // CLI (1.5.5) on the real fixture column:
    //   SELECT count(*), sum("weird ""quoted"" key") FROM v;
    //   ┌───────────────┬────────┐
    //   │ count_star()  │  12    │
    //   │ sum(...)      │  78    │  ← 1+2+…+12, the hostile column's values
    //   └───────────────┴────────┘
    expect(pathExtractSql('assay_t1', ['weird "quoted" key'])).toEqual({
      ok: true,
      sql: 'SELECT "weird ""quoted"" key" AS "weird ""quoted"" key" FROM "assay_t1"',
    })
    // (b) Hostile field name in the literal context (embedded double quotes
    // are inert inside single-quoted literals; the alias re-quotes them in
    // identifier context).
    expect(pathExtractSql('assay_t1', ['meta', 'weird "quoted" key'])).toEqual({
      ok: true,
      sql: `SELECT "meta"['weird "quoted" key'] AS "meta.weird ""quoted"" key" FROM "assay_t1"`,
    })
    // (c) Embedded single quote — the only literal escape is '' doubling.
    // CLI (1.5.5): SELECT 'a\'b' → Parser Error (backslash is NOT an escape),
    // so no backslash sequence can break out; verified working:
    //   SELECT d['a''b'] FROM (SELECT CAST('{"a''b":10}' AS STRUCT("a'b" INTEGER)) AS d) → 10
    expect(pathExtractSql('assay_t1', ['meta', "it's"])).toEqual({
      ok: true,
      sql: `SELECT "meta"['it''s'] AS "meta.it's" FROM "assay_t1"`,
    })
    // (d) Statement-splice attempts (`;`, `--`) stay inert inside both contexts.
    expect(pathExtractSql('assay_t1', ['id; DROP VIEW x', '-- comment'])).toEqual({
      ok: true,
      sql: `SELECT "id; DROP VIEW x"['-- comment'] AS "id; DROP VIEW x.-- comment" FROM "assay_t1"`,
    })
    // (e) Unicode and bracket-hostile field names. CLI (1.5.5):
    //   SELECT struct_pack("weird ]key[" := 7)['weird ]key['] → 7
    //   SELECT struct_pack("héllo → 世界" := 9)['héllo → 世界'] → 9
    expect(pathExtractSql('assay_t1', ['meta', 'weird ]key['])).toEqual({
      ok: true,
      sql: `SELECT "meta"['weird ]key['] AS "meta.weird ]key[" FROM "assay_t1"`,
    })
    expect(pathExtractSql('assay_t1', ['héllo → 世界'])).toEqual({
      ok: true,
      sql: `SELECT "héllo → 世界" AS "héllo → 世界" FROM "assay_t1"`,
    })
    // (f) Empty-string field composes mechanically (`['']`); DuckDB itself
    // rejects empty struct field names at bind time ("zero-length delimited
    // identifier", verified) — the engine decides, not the composer.
    expect(pathExtractSql('assay_t1', ['meta', ''])).toEqual({
      ok: true,
      sql: `SELECT "meta"[''] AS "meta." FROM "assay_t1"`,
    })
  })

  it('rejects malformed paths with honest reasons', () => {
    expect(pathExtractSql('', ['meta'])).toEqual({
      ok: false,
      reason: 'viewName must be a non-empty string',
    })
    expect(pathExtractSql('assay_t1', [])).toEqual({
      ok: false,
      reason: 'path must name a column',
    })
    expect(pathExtractSql('assay_t1', [0])).toEqual({
      ok: false,
      reason: 'path must start with a column name, not an index',
    })
    expect(pathExtractSql('assay_t1', ['tags', -1])).toEqual({
      ok: false,
      reason: 'list index must be a non-negative integer (got -1)',
    })
    expect(pathExtractSql('assay_t1', ['tags', Number.NaN])).toEqual({
      ok: false,
      reason: 'list index must be a non-negative integer (got NaN)',
    })
    expect(pathExtractSql('assay_t1', ['tags', 1.5])).toEqual({
      ok: false,
      reason: 'list index must be a non-negative integer (got 1.5)',
    })
  })
})

describe('type model — the composer inputs come from the parsed DESCRIBE strings', () => {
  it('parses the fixture types into the shapes the composer branches on', () => {
    // Guards against parseType drift silently changing composer decisions:
    // list-vs-struct detection, fixed-size-array detection, field names.
    expect(NESTED_JSONL_COLUMNS[6]?.type).toEqual({
      kind: 'list',
      element: { kind: 'primitive', label: 'VARCHAR' },
      dimensions: '[]',
    })
    expect(NESTED_JSONL_COLUMNS[7]?.type).toEqual({
      kind: 'list',
      element: {
        kind: 'struct',
        fields: [
          { name: 'at', type: { kind: 'primitive', label: 'TIMESTAMP' } },
          { name: 'ok', type: { kind: 'primitive', label: 'BOOLEAN' } },
        ],
      },
      dimensions: '[]',
    })
    const deep = NESTED_JSONL_COLUMNS[4]?.type
    expect(deep?.kind).toBe('struct')
    expect((deep as Extract<DuckDbType, { kind: 'struct' }>).fields[0]?.name).toBe('a')
  })
})
