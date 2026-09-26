// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import {
  compileRowDiffPlan,
  DEFAULT_ROW_DIFF_SAMPLE_LIMIT,
  keyTypesCompatible,
} from './row-diff-compile'
import type { RowDiffPlan } from './row-diff-plan'
import { DIFF_PLAN_KIND, DIFF_PLAN_VERSION, ROW_DIFF_ASPECTS } from './row-diff-plan'
import { describeRowDiffBindingError } from './row-diff-errors'
import { scanOrdinalScopes } from './diff-property-testing'

/**
 * Golden-SQL byte pins and binding-error pins (m6-1). The SQL strings are
 * the reviewed surface: identical inputs must keep producing them
 * byte-for-byte, and the m6-2 executor binds against exactly these shapes.
 * The goldens were executed against the pinned DuckDB CLI 1.5.5 during
 * development (the pure package never executes them — the env-gated
 * agreement runs live in the m6-2 engine work): hostile names bind, NULL
 * keys pair, counts stay exact under LIMIT, and the keys-only case is
 * structurally empty.
 *
 * Note the shape's collision-freedom invariants (row-diff-plan.ts): source
 * columns appear only range-qualified (`"a"."col"` / `"b"."col"`), derived
 * tables expose only reserved aliases, so any dataset column name —
 * including the range names, `assay_*` in any casing, quotes, spaces —
 * binds and executes correctly.
 */

/** Join literal SQL lines (data, not compiler logic). */
function lines(...parts: string[]): string {
  return parts.join('\n')
}

const G1_SCHEMA_A = [
  { name: 'id', type: 'BIGINT' },
  { name: 'email', type: 'VARCHAR' },
  { name: 'amount', type: 'DECIMAL(10,2)' },
]
const G1_SCHEMA_B = [
  { name: 'id', type: 'BIGINT' },
  { name: 'email', type: 'VARCHAR' },
  { name: 'region', type: 'VARCHAR' },
]
const G1_OPTIONS = { relationA: 'ds_a', relationB: 'scratch_ds_b', sampleLimit: 3 }

function compilePlan(
  schemaA: readonly { name: string; type: string }[],
  schemaB: readonly { name: string; type: string }[],
  keys: readonly string[],
  options: { relationA: string; relationB: string; sampleLimit?: number },
): RowDiffPlan {
  const result = compileRowDiffPlan(schemaA, schemaB, keys, options)
  if (!result.ok) throw new Error(`golden compile failed: ${JSON.stringify(result.errors)}`)
  return result.plan
}

const G1_ADDED_SQL = lines(
  'SELECT',
  `  'B' AS "assay_side",`,
  '  "assay_row_ordinal",',
  '  row_number() OVER () - 1 AS "sample_index",',
  '  count(*) OVER () AS "assay_count"',
  'FROM (',
  '  SELECT "assay_row_ordinal"',
  '  FROM (',
  '    SELECT row_number() OVER () - 1 AS "assay_row_ordinal",',
  '           "b"."id" AS "assay_key_0"',
  '    FROM "scratch_ds_b" AS "b"',
  '  ) AS "assay_antijoin_source"',
  '  WHERE NOT EXISTS (',
  '    SELECT 1',
  '    FROM "ds_a" AS "a"',
  '    WHERE "a"."id" IS NOT DISTINCT FROM "assay_antijoin_source"."assay_key_0"',
  '  )',
  ') AS "assay_added_rows"',
  'LIMIT 3',
)

const G1_REMOVED_SQL = lines(
  'SELECT',
  `  'A' AS "assay_side",`,
  '  "assay_row_ordinal",',
  '  row_number() OVER () - 1 AS "sample_index",',
  '  count(*) OVER () AS "assay_count"',
  'FROM (',
  '  SELECT "assay_row_ordinal"',
  '  FROM (',
  '    SELECT row_number() OVER () - 1 AS "assay_row_ordinal",',
  '           "a"."id" AS "assay_key_0"',
  '    FROM "ds_a" AS "a"',
  '  ) AS "assay_antijoin_source"',
  '  WHERE NOT EXISTS (',
  '    SELECT 1',
  '    FROM "scratch_ds_b" AS "b"',
  '    WHERE "b"."id" IS NOT DISTINCT FROM "assay_antijoin_source"."assay_key_0"',
  '  )',
  ') AS "assay_removed_rows"',
  'LIMIT 3',
)

const G1_CHANGED_SQL = lines(
  'SELECT',
  `  'A' AS "assay_side",`,
  '  "assay_row_ordinal",',
  '  "assay_changed",',
  '  row_number() OVER () - 1 AS "sample_index",',
  '  count(*) OVER () AS "assay_count"',
  'FROM (',
  '  SELECT "ai"."assay_row_ordinal",',
  '         list_concat(',
  `           CASE WHEN "ai"."assay_col_0" IS DISTINCT FROM "bi"."assay_col_0" THEN ['email'] ELSE [] END`,
  `         ) AS "assay_changed"`,
  '  FROM (',
  '    SELECT row_number() OVER () - 1 AS "assay_row_ordinal",',
  '         "a"."id" AS "assay_key_0",',
  '         "a"."email" AS "assay_col_0",',
  '         TRUE AS "assay_present_a"',
  '    FROM "ds_a" AS "a"',
  '  ) AS "ai"',
  '  FULL OUTER JOIN (',
  '    SELECT "b"."id" AS "assay_key_0",',
  '         "b"."email" AS "assay_col_0",',
  '         TRUE AS "assay_present_b"',
  '    FROM "scratch_ds_b" AS "b"',
  '  ) AS "bi"',
  '    ON "ai"."assay_key_0" IS NOT DISTINCT FROM "bi"."assay_key_0"',
  '  WHERE "ai"."assay_present_a" IS NOT NULL',
  '    AND "bi"."assay_present_b" IS NOT NULL',
  '    AND ("ai"."assay_col_0" IS DISTINCT FROM "bi"."assay_col_0")',
  ') AS "assay_changed_rows"',
  'LIMIT 3',
)

const G1_TOTALS_SQL = lines(
  `SELECT 'added' AS "assay_aspect", count(*) AS "assay_count"`,
  'FROM (',
  '  SELECT "assay_row_ordinal"',
  '  FROM (',
  '    SELECT row_number() OVER () - 1 AS "assay_row_ordinal",',
  '           "b"."id" AS "assay_key_0"',
  '    FROM "scratch_ds_b" AS "b"',
  '  ) AS "assay_antijoin_source"',
  '  WHERE NOT EXISTS (',
  '    SELECT 1',
  '    FROM "ds_a" AS "a"',
  '    WHERE "a"."id" IS NOT DISTINCT FROM "assay_antijoin_source"."assay_key_0"',
  '  )',
  ') AS "assay_added_total"',
  'UNION ALL',
  `SELECT 'removed' AS "assay_aspect", count(*) AS "assay_count"`,
  'FROM (',
  '  SELECT "assay_row_ordinal"',
  '  FROM (',
  '    SELECT row_number() OVER () - 1 AS "assay_row_ordinal",',
  '           "a"."id" AS "assay_key_0"',
  '    FROM "ds_a" AS "a"',
  '  ) AS "assay_antijoin_source"',
  '  WHERE NOT EXISTS (',
  '    SELECT 1',
  '    FROM "scratch_ds_b" AS "b"',
  '    WHERE "b"."id" IS NOT DISTINCT FROM "assay_antijoin_source"."assay_key_0"',
  '  )',
  ') AS "assay_removed_total"',
  'UNION ALL',
  `SELECT 'changed' AS "assay_aspect", count(*) AS "assay_count"`,
  'FROM (',
  '  SELECT "ai"."assay_row_ordinal",',
  '         list_concat(',
  `           CASE WHEN "ai"."assay_col_0" IS DISTINCT FROM "bi"."assay_col_0" THEN ['email'] ELSE [] END`,
  `         ) AS "assay_changed"`,
  '  FROM (',
  '    SELECT row_number() OVER () - 1 AS "assay_row_ordinal",',
  '         "a"."id" AS "assay_key_0",',
  '         "a"."email" AS "assay_col_0",',
  '         TRUE AS "assay_present_a"',
  '    FROM "ds_a" AS "a"',
  '  ) AS "ai"',
  '  FULL OUTER JOIN (',
  '    SELECT "b"."id" AS "assay_key_0",',
  '         "b"."email" AS "assay_col_0",',
  '         TRUE AS "assay_present_b"',
  '    FROM "scratch_ds_b" AS "b"',
  '  ) AS "bi"',
  '    ON "ai"."assay_key_0" IS NOT DISTINCT FROM "bi"."assay_key_0"',
  '  WHERE "ai"."assay_present_a" IS NOT NULL',
  '    AND "bi"."assay_present_b" IS NOT NULL',
  '    AND ("ai"."assay_col_0" IS DISTINCT FROM "bi"."assay_col_0")',
  ') AS "assay_changed_total"',
)

describe('row-diff plan — golden SQL pins (single key)', () => {
  const plan = compilePlan(G1_SCHEMA_A, G1_SCHEMA_B, ['id'], G1_OPTIONS)

  it('added: the B-keys anti-join, byte-exact', () => {
    expect(plan.addedSql).toBe(G1_ADDED_SQL)
  })

  it('removed: the A-keys anti-join, byte-exact (exact side symmetry, not a text swap)', () => {
    expect(plan.removedSql).toBe(G1_REMOVED_SQL)
    // Symmetry is structural (roles swapped), never a string replacement of
    // one range for the other inside one text.
    expect(plan.addedSql).not.toBe(plan.removedSql)
  })

  it('changed: the full outer join on key with presence markers, byte-exact', () => {
    expect(plan.changedSql).toBe(G1_CHANGED_SQL)
  })

  it('totals: one arm per aspect in the documented order, sharing the same sources', () => {
    expect(plan.totalsSql).toBe(G1_TOTALS_SQL)
    // per-aspect ≡ totals structural agreement: each totals arm embeds the
    // IDENTICAL source fragment as the corresponding per-aspect query
    // (shared builders — m6-2/m6-5 pin the resulting counts equal).
    const aspectSources = {
      added: plan.addedSql,
      removed: plan.removedSql,
      changed: plan.changedSql,
    }
    const arms = plan.totalsSql.split('\nUNION ALL\n')
    ROW_DIFF_ASPECTS.forEach((aspect, i) => {
      const source = aspectSources[aspect] as string
      // the per-aspect FROM-block (source embedded) sits between its first
      // 'FROM (' and the wrapper alias line; the totals arm embeds the same
      const fromStart = source.indexOf('FROM (')
      const sourceBlock = source.slice(fromStart, source.lastIndexOf('\n) AS '))
      const arm = arms[i] as string
      expect(arm).toContain(`'${aspect}' AS "assay_aspect"`)
      expect(arm).toContain(sourceBlock)
    })
  })

  it('plan metadata: kind, version, echoed keys, default K, shared columns in A-order', () => {
    expect(plan.planKind).toBe(DIFF_PLAN_KIND)
    expect(plan.planVersion).toBe(DIFF_PLAN_VERSION)
    expect(plan.keys).toEqual(['id'])
    expect(plan.relationA).toBe('ds_a')
    expect(plan.relationB).toBe('scratch_ds_b')
    expect(plan.sampleLimit).toBe(3)
    // shared non-key columns in schema-A order; keys excluded (they cannot
    // differ on a matched pair — they define the match). `amount` is
    // A-only here — an added/removed COLUMN finding (m6-0), never compared.
    expect(plan.sharedColumns).toEqual(['email'])
  })

  it('default K is 20 when sampleLimit is omitted (m5-1-consistent default)', () => {
    expect(DEFAULT_ROW_DIFF_SAMPLE_LIMIT).toBe(20)
    const plan2 = compilePlan(G1_SCHEMA_A, G1_SCHEMA_B, ['id'], {
      relationA: 'ds_a',
      relationB: 'scratch_ds_b',
    })
    expect(plan2.sampleLimit).toBe(20)
    expect(plan2.addedSql.endsWith('LIMIT 20')).toBe(true)
  })
})

describe('row-diff plan — golden SQL pins (multi-key, hostile names, NULL-key semantics)', () => {
  // Hostile names: spaces, `#`, double quotes (doubled inside identifiers),
  // and columns named exactly like plan internals in any casing (`b`, the
  // range name; `assay_row_ordinal`/`ASSAY_ROW_ORDINAL`; `assay_key_0`).
  const schemaA = [
    { name: 'i d', type: 'INTEGER' },
    { name: 'k#2', type: 'VARCHAR' },
    { name: 'a"q', type: 'INTEGER' },
    { name: 'assay_row_ordinal', type: 'DOUBLE' },
    { name: 'b', type: 'DATE' },
  ]
  const schemaB = [
    { name: 'i d', type: 'INTEGER' },
    { name: 'k#2', type: 'VARCHAR' },
    { name: 'a"q', type: 'INTEGER' },
    { name: 'ASSAY_ROW_ORDINAL', type: 'DOUBLE' },
    { name: 'b', type: 'DATE' },
    { name: 'assay_key_0', type: 'BOOLEAN' },
  ]
  const plan = compilePlan(schemaA, schemaB, ['i d', 'k#2'], {
    relationA: 'ra',
    relationB: 'rb',
  })

  it('multi-key added: both key conditions, IS NOT DISTINCT FROM (NULL keys group)', () => {
    expect(plan.addedSql).toBe(
      lines(
        'SELECT',
        `  'B' AS "assay_side",`,
        '  "assay_row_ordinal",',
        '  row_number() OVER () - 1 AS "sample_index",',
        '  count(*) OVER () AS "assay_count"',
        'FROM (',
        '  SELECT "assay_row_ordinal"',
        '  FROM (',
        '    SELECT row_number() OVER () - 1 AS "assay_row_ordinal",',
        '           "b"."i d" AS "assay_key_0",',
        '           "b"."k#2" AS "assay_key_1"',
        '    FROM "rb" AS "b"',
        '  ) AS "assay_antijoin_source"',
        '  WHERE NOT EXISTS (',
        '    SELECT 1',
        '    FROM "ra" AS "a"',
        '    WHERE "a"."i d" IS NOT DISTINCT FROM "assay_antijoin_source"."assay_key_0"',
        '      AND "a"."k#2" IS NOT DISTINCT FROM "assay_antijoin_source"."assay_key_1"',
        '  )',
        ') AS "assay_added_rows"',
        'LIMIT 20',
      ),
    )
  })

  it('multi-key changed: hostile names bind (quotes doubled, ranges and assay_* casings as columns)', () => {
    expect(plan.changedSql).toBe(
      lines(
        'SELECT',
        `  'A' AS "assay_side",`,
        '  "assay_row_ordinal",',
        '  "assay_changed",',
        '  row_number() OVER () - 1 AS "sample_index",',
        '  count(*) OVER () AS "assay_count"',
        'FROM (',
        '  SELECT "ai"."assay_row_ordinal",',
        '         list_concat(',
        `           CASE WHEN "ai"."assay_col_0" IS DISTINCT FROM "bi"."assay_col_0" THEN ['a"q'] ELSE [] END,`,
        `           CASE WHEN "ai"."assay_col_1" IS DISTINCT FROM "bi"."assay_col_1" THEN ['b'] ELSE [] END`,
        `         ) AS "assay_changed"`,
        '  FROM (',
        '    SELECT row_number() OVER () - 1 AS "assay_row_ordinal",',
        '         "a"."i d" AS "assay_key_0",',
        '         "a"."k#2" AS "assay_key_1",',
        '         "a"."a""q" AS "assay_col_0",',
        '         "a"."b" AS "assay_col_1",',
        '         TRUE AS "assay_present_a"',
        '    FROM "ra" AS "a"',
        '  ) AS "ai"',
        '  FULL OUTER JOIN (',
        '    SELECT "b"."i d" AS "assay_key_0",',
        '         "b"."k#2" AS "assay_key_1",',
        '         "b"."a""q" AS "assay_col_0",',
        '         "b"."b" AS "assay_col_1",',
        '         TRUE AS "assay_present_b"',
        '    FROM "rb" AS "b"',
        '  ) AS "bi"',
        '    ON "ai"."assay_key_0" IS NOT DISTINCT FROM "bi"."assay_key_0"',
        '     AND "ai"."assay_key_1" IS NOT DISTINCT FROM "bi"."assay_key_1"',
        '  WHERE "ai"."assay_present_a" IS NOT NULL',
        '    AND "bi"."assay_present_b" IS NOT NULL',
        '    AND ("ai"."assay_col_0" IS DISTINCT FROM "bi"."assay_col_0"',
        '      OR "ai"."assay_col_1" IS DISTINCT FROM "bi"."assay_col_1")',
        ') AS "assay_changed_rows"',
        'LIMIT 20',
      ),
    )
    // changed-column list order: shared non-key columns in schema-A order,
    // carried as string literals — here `a"q` (with its quote) then `b`.
    expect(plan.sharedColumns).toEqual(['a"q', 'b'])
  })

  it('NULL-key semantics are structural: every join/anti-join condition is IS NOT DISTINCT FROM', () => {
    // Two NULL keys are the SAME key (documented v1 semantic). The golden
    // SQL must contain no equality-based join condition anywhere — NULL=
    // NULL would never match, splitting a NULL-key row into added+removed.
    for (const sql of [plan.addedSql, plan.removedSql, plan.changedSql, plan.totalsSql]) {
      expect(sql).not.toMatch(/=\s*[^=]/) // no bare equality (only IS [NOT] DISTINCT FROM)
      expect(sql).toContain('IS NOT DISTINCT FROM')
    }
    // and the presence markers (which make NULL-key matched pairs decodable
    // in the full outer join) are exactly where the design puts them.
    expect(plan.changedSql).toContain('TRUE AS "assay_present_a"')
    expect(plan.changedSql).toContain('TRUE AS "assay_present_b"')
    expect(plan.changedSql).toContain('"ai"."assay_present_a" IS NOT NULL')
    expect(plan.changedSql).toContain('"bi"."assay_present_b" IS NOT NULL')
  })
})

describe('row-diff plan — golden SQL pins (keys-only: no comparable columns)', () => {
  // Keys shared, nothing else: `changed` is structurally empty (a matched
  // pair's keys are equal by the join condition, so nothing can differ).
  const plan = compilePlan(
    [{ name: 'id', type: 'BIGINT' }],
    [{ name: 'id', type: 'BIGINT' }],
    ['id'],
    { relationA: 'ra3', relationB: 'rb3' },
  )

  it('changed degrades to the never-true guard with a typed empty list', () => {
    expect(plan.changedSql).toContain('AND FALSE')
    expect(plan.changedSql).toContain('CAST([] AS VARCHAR[]) AS "assay_changed"')
    expect(plan.sharedColumns).toEqual([])
  })

  it('added/removed still work (keys are all the anti-joins need)', () => {
    expect(plan.addedSql).toContain(
      '"a"."id" IS NOT DISTINCT FROM "assay_antijoin_source"."assay_key_0"',
    )
    expect(plan.removedSql).toContain(
      '"b"."id" IS NOT DISTINCT FROM "assay_antijoin_source"."assay_key_0"',
    )
  })
})

describe('row-diff plan — determinism and JSON stability', () => {
  it('compile twice → byte-identical plan (SQL text and JSON)', () => {
    const first = compilePlan(G1_SCHEMA_A, G1_SCHEMA_B, ['id', 'email'], G1_OPTIONS)
    const second = compileRowDiffPlan(G1_SCHEMA_A, G1_SCHEMA_B, ['id', 'email'], G1_OPTIONS)
    expect(second.ok).toBe(true)
    expect(JSON.stringify(second)).toBe(JSON.stringify({ ok: true, plan: first }))
    expect(first.addedSql).toBe((second as { plan: RowDiffPlan }).plan.addedSql)
  })

  it('plan is plain JSON-representable data: JSON.parse(JSON.stringify(plan)) ≡ plan', () => {
    const plan = compilePlan(G1_SCHEMA_A, G1_SCHEMA_B, ['id', 'email'], G1_OPTIONS)
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan)
    expect(Object.is(JSON.parse(JSON.stringify(plan)).sampleLimit, -0)).toBe(false)
  })

  it('key order is part of the input: a different order is a different (valid) plan', () => {
    const ab = compilePlan(G1_SCHEMA_A, G1_SCHEMA_B, ['id', 'email'], G1_OPTIONS)
    const ba = compilePlan(G1_SCHEMA_A, G1_SCHEMA_B, ['email', 'id'], G1_OPTIONS)
    expect(ab.keys).toEqual(['id', 'email'])
    expect(ba.keys).toEqual(['email', 'id'])
    // key order drives the projection order and the key alias indices
    expect(ba.changedSql).toContain('"a"."email" AS "assay_key_0"')
    expect(ba.changedSql).toContain('"a"."id" AS "assay_key_1"')
    expect(ab.changedSql).toContain('"a"."id" AS "assay_key_0"')
    expect(ab.changedSql).toContain('"a"."email" AS "assay_key_1"')
  })

  it('default option values are resolved once and echoed (relation spellings)', () => {
    const plan = compilePlan(G1_SCHEMA_A, G1_SCHEMA_B, ['id'], {
      relationA: 'we"rd',
      relationB: 'a',
    })
    expect(plan.relationA).toBe('we"rd')
    expect(plan.relationB).toBe('a')
    // the relation enters SQL only through the quoting helper; the range
    // names stay fixed ("a"/"b") whatever the relations are called
    expect(plan.addedSql).toContain('FROM "we""rd" AS "a"')
    expect(plan.addedSql).toContain('FROM "a" AS "b"')
  })
})

describe('row-diff plan — structural injection pins (scan every generated query)', () => {
  /** Char-exact scanner: quotes may nest (a name can contain the other quote). */
  function scanSql(sql: string): {
    literals: string[]
    identifiers: string[]
    unquoted: string
  } {
    const literals: string[] = []
    const identifiers: string[] = []
    let unquoted = ''
    let i = 0
    while (i < sql.length) {
      const ch: string = sql[i] as string
      if (ch === "'") {
        let j = i + 1
        let lit = ''
        while (j < sql.length) {
          if (sql[j] === "'" && sql[j + 1] === "'") {
            lit += "'"
            j += 2
            continue
          }
          if (sql[j] === "'") break
          lit += sql[j] as string
          j += 1
        }
        literals.push(lit)
        unquoted += "''"
        i = j + 1
        continue
      }
      if (ch === '"') {
        let j = i + 1
        let id = ''
        while (j < sql.length) {
          if (sql[j] === '"' && sql[j + 1] === '"') {
            id += '"'
            j += 2
            continue
          }
          if (sql[j] === '"') break
          id += sql[j] as string
          j += 1
        }
        identifiers.push(id)
        unquoted += '""'
        i = j + 1
        continue
      }
      unquoted += ch
      i += 1
    }
    return { literals, identifiers, unquoted }
  }

  const SQL_KEYWORDS = new Set([
    'SELECT',
    'FROM',
    'AS',
    'WHERE',
    'AND',
    'OR',
    'NOT',
    'EXISTS',
    'IS',
    'DISTINCT',
    'NULL',
    'TRUE',
    'FALSE',
    'CASE',
    'WHEN',
    'THEN',
    'ELSE',
    'END',
    'LIMIT',
    'UNION',
    'ALL',
    'FULL',
    'OUTER',
    'JOIN',
    'ON',
    'OVER',
    'CAST',
    'VARCHAR',
  ])
  const SQL_FUNCTIONS = new Set(['count', 'row_number', 'list_concat'])

  function assertStructurallySafe(
    plan: RowDiffPlan,
    input: {
      relationA: string
      relationB: string
      keys: readonly string[]
    },
  ): void {
    const reserved = new Set([
      'a',
      'b',
      'ai',
      'bi', // the documented range names (inner + outer)
      'assay_antijoin_source', // the anti-join's ordinal-preserving derived table
      'assay_side',
      'assay_row_ordinal',
      'assay_changed',
      'assay_count',
      'assay_aspect',
      'sample_index',
      'assay_present_a',
      'assay_present_b',
      'assay_added_rows',
      'assay_removed_rows',
      'assay_changed_rows',
      'assay_added_total',
      'assay_removed_total',
      'assay_changed_total',
      ...plan.keys.map((_, i) => `assay_key_${i}`),
      ...plan.sharedColumns.map((_, j) => `assay_col_${j}`),
    ])
    const allowedLiterals = new Set(['A', 'B', 'added', 'removed', 'changed'])
    for (const sql of [plan.addedSql, plan.removedSql, plan.changedSql, plan.totalsSql]) {
      const { literals, identifiers, unquoted } = scanSql(sql)
      // 1. every double-quoted identifier is either a caller name (used
      //    exactly as given) or a reserved plan name — nothing else.
      const allowedIdentifiers = new Set([
        input.relationA,
        input.relationB,
        ...input.keys,
        ...plan.sharedColumns,
        ...reserved,
      ])
      for (const id of identifiers) expect(allowedIdentifiers.has(id)).toBe(true)
      // 2. every single-quoted literal is an internal constant or a column
      //    NAME carried into the changed-column list — never a value.
      const allowedWithColumns = new Set([...allowedLiterals, ...plan.sharedColumns])
      for (const lit of literals) expect(allowedWithColumns.has(lit)).toBe(true)
      // 3. nothing outside quotes parses as a bare identifier: only the
      //    fixed keyword/function vocabulary ever appears unquoted.
      const words = unquoted.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []
      for (const word of words) {
        expect(SQL_KEYWORDS.has(word) || SQL_FUNCTIONS.has(word)).toBe(true)
      }
      // 4. every `assay_row_ordinal` window is computed over an unfiltered
      //    relation — its SELECT scope carries no sibling WHERE (see
      //    `scanOrdinalScopes`; the round-1 post-filter defect class).
      expect(scanOrdinalScopes(sql).violations).toEqual([])
    }
  }

  it('single-key plan: identifiers quoted, literals are names/constants only', () => {
    const plan = compilePlan(G1_SCHEMA_A, G1_SCHEMA_B, ['id'], G1_OPTIONS)
    assertStructurallySafe(plan, { relationA: 'ds_a', relationB: 'scratch_ds_b', keys: ['id'] })
  })

  it('multi-key hostile-name plan: quotes/spaces/assay_* names all stay inside quotes', () => {
    const plan = compilePlan(
      [
        { name: 'i d', type: 'INTEGER' },
        { name: 'k#2', type: 'VARCHAR' },
        { name: "a'b", type: 'INTEGER' },
        { name: 'a"q', type: 'INTEGER' },
        { name: 'select', type: 'DATE' },
        { name: 'ASSAY_SIDE', type: 'DOUBLE' },
      ],
      [
        { name: 'i d', type: 'INTEGER' },
        { name: 'k#2', type: 'VARCHAR' },
        { name: "a'b", type: 'INTEGER' },
        { name: 'a"q', type: 'INTEGER' },
        { name: 'select', type: 'DATE' },
        { name: 'ASSAY_SIDE', type: 'DOUBLE' },
      ],
      ['i d', 'k#2'],
      { relationA: 'we"rd', relationB: "b'd", sampleLimit: 1 },
    )
    assertStructurallySafe(plan, {
      relationA: 'we"rd',
      relationB: "b'd",
      keys: ['i d', 'k#2'],
    })
  })

  it('structural ordinal pin: every aspect computes assay_row_ordinal pre-filter, and the scanner catches the defect shape', () => {
    const plan = compilePlan(G1_SCHEMA_A, G1_SCHEMA_B, ['id', 'email'], G1_OPTIONS)
    let ordinalWindows = 0
    for (const sql of [plan.addedSql, plan.removedSql, plan.changedSql, plan.totalsSql]) {
      const scan = scanOrdinalScopes(sql)
      ordinalWindows += scan.ordinalWindows
      expect(scan.violations).toEqual([])
    }
    // non-vacuity: added + removed + changed + three totals arms each carry
    // exactly one top-level ordinal window (the m5-1 inner projection).
    expect(ordinalWindows).toBe(6)

    // negative control: the round-1 defect shape (ordinal window sharing its
    // SELECT with the anti-join WHERE) is caught, so this pin cannot go
    // green if post-filter numbering reappears.
    const regressed = [
      'SELECT row_number() OVER () - 1 AS "assay_row_ordinal"',
      'FROM "b" AS "b"',
      'WHERE NOT EXISTS (SELECT 1 FROM "a" AS "a" WHERE "a"."id" IS NOT DISTINCT FROM "b"."id")',
    ].join('\n')
    const bad = scanOrdinalScopes(regressed)
    expect(bad.ordinalWindows).toBe(1)
    expect(bad.violations).toHaveLength(1)
    expect(bad.violations[0]).toContain('WHERE NOT EXISTS')
  })
})

describe('row-diff plan — key-type compatibility policy (documented, pinned)', () => {
  it('same flat family = compatible across spellings', () => {
    expect(keyTypesCompatible('INTEGER', 'BIGINT')).toBe(true)
    expect(keyTypesCompatible('VARCHAR(3)', 'VARCHAR')).toBe(true)
    expect(keyTypesCompatible('DECIMAL(10,2)', 'DOUBLE')).toBe(true)
    expect(keyTypesCompatible('TIMESTAMP', 'DATE')).toBe(true)
    expect(keyTypesCompatible('VARCHAR', 'VARCHAR')).toBe(true)
  })

  it('different flat families = refused (no implicit cross-family key match)', () => {
    expect(keyTypesCompatible('INTEGER', 'VARCHAR')).toBe(false)
    expect(keyTypesCompatible('BOOLEAN', 'BIGINT')).toBe(false)
    expect(keyTypesCompatible('DATE', 'VARCHAR')).toBe(false)
  })

  it('JSON is refused on any side (textual equality would be approximate)', () => {
    expect(keyTypesCompatible('JSON', 'JSON')).toBe(false)
    expect(keyTypesCompatible('JSON', 'VARCHAR')).toBe(false)
    expect(keyTypesCompatible('BIGINT', 'JSON')).toBe(false)
  })

  it("nested/unknown ('other') binds only on byte-identical spellings", () => {
    expect(keyTypesCompatible('INTEGER[]', 'INTEGER[]')).toBe(true)
    expect(keyTypesCompatible('STRUCT(a INTEGER)', 'STRUCT(a INTEGER)')).toBe(true)
    expect(keyTypesCompatible('INTEGER[]', 'BIGINT[]')).toBe(false)
    expect(keyTypesCompatible('STRUCT(a INTEGER)', 'STRUCT(a BIGINT)')).toBe(false)
    expect(keyTypesCompatible('WEIRD', 'WEIRD')).toBe(true)
    expect(keyTypesCompatible('WEIRD', 'INTEGER')).toBe(false)
    expect(keyTypesCompatible('INTEGER[]', 'VARCHAR')).toBe(false)
  })

  it('an accepted same-family cross-spelling key compiles; JSON and cross-family keys are typed errors', () => {
    const schemaA = [
      { name: 'k', type: 'INTEGER' },
      { name: 'j', type: 'JSON' },
    ]
    const schemaB = [
      { name: 'k', type: 'BIGINT' },
      { name: 'j', type: 'JSON' },
    ]
    const ok = compileRowDiffPlan(schemaA, schemaB, ['k'], {
      relationA: 'a',
      relationB: 'b',
    })
    expect(ok.ok).toBe(true)

    const json = compileRowDiffPlan(schemaA, schemaB, ['j'], { relationA: 'a', relationB: 'b' })
    expect(json.ok).toBe(false)
    if (json.ok) return
    expect(json.errors.map((e) => e.code)).toEqual(['key-type-mismatch'])
    expect(json.errors[0]?.message).toContain('JSON keys are refused')
    expect(json.errors[0]?.message).toContain("'JSON'") // exact spellings echoed
    expect(json.errors[0]?.column).toBe('j')

    const cross = compileRowDiffPlan(
      [{ name: 'k', type: 'INTEGER' }],
      [{ name: 'k', type: 'VARCHAR' }],
      ['k'],
      { relationA: 'a', relationB: 'b' },
    )
    expect(cross.ok).toBe(false)
    if (cross.ok) return
    expect(cross.errors.map((e) => e.code)).toEqual(['key-type-mismatch'])
    expect(cross.errors[0]?.message).toContain("'INTEGER' on side A (family 'numeric')")
    expect(cross.errors[0]?.message).toContain("'VARCHAR' on side B (family 'textual')")
  })
})

describe('row-diff plan — binding errors (typed, collected, attributed, never-echo)', () => {
  const healthySchemaA = G1_SCHEMA_A
  const healthySchemaB = G1_SCHEMA_B
  const healthyOptions = { relationA: 'ds_a', relationB: 'scratch_ds_b' }

  it('empty key set → empty-key-set (keys are explicit, never an implicit guess — C2)', () => {
    const result = compileRowDiffPlan(healthySchemaA, healthySchemaB, [], healthyOptions)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.map((e) => e.code)).toEqual(['empty-key-set'])
    expect(result.errors[0]?.message).toContain('explicit key columns')
  })

  it('duplicate key columns (exact and case-insensitive) are binding errors naming both spellings', () => {
    const exact = compileRowDiffPlan(healthySchemaA, healthySchemaB, ['id', 'id'], healthyOptions)
    expect(exact.ok).toBe(false)
    if (!exact.ok) {
      expect(exact.errors.map((e) => e.code)).toEqual(['duplicate-key-column'])
      expect(exact.errors[0]?.message).toContain("'id' is listed more than once")
      expect(exact.errors[0]?.column).toBe('id')
    }
    const ci = compileRowDiffPlan(
      [
        { name: 'id', type: 'BIGINT' },
        { name: 'ID', type: 'BIGINT' },
      ],
      [
        { name: 'id', type: 'BIGINT' },
        { name: 'ID', type: 'BIGINT' },
      ],
      ['id', 'ID'],
      healthyOptions,
    )
    expect(ci.ok).toBe(false)
    if (!ci.ok) {
      expect(ci.errors.map((e) => e.code)).toEqual(['duplicate-key-column'])
      expect(ci.errors[0]?.message).toContain("'id' and 'ID' collide case-insensitively")
    }
  })

  it('key-set shape problems are invalid-keys-input; offending values are echoed exactly, never mangled', () => {
    const notArray = compileRowDiffPlan(
      healthySchemaA,
      healthySchemaB,
      'id' as never,
      healthyOptions,
    )
    expect(notArray.ok).toBe(false)
    if (!notArray.ok) {
      expect(notArray.errors.map((e) => e.code)).toEqual(['invalid-keys-input'])
      expect(notArray.errors[0]?.message).toContain("got 'id'")
    }
    const badEntry = compileRowDiffPlan(
      healthySchemaA,
      healthySchemaB,
      ['id', 42] as never,
      healthyOptions,
    )
    expect(badEntry.ok).toBe(false)
    if (!badEntry.ok) {
      expect(badEntry.errors.map((e) => e.code)).toEqual(['invalid-keys-input'])
      expect(badEntry.errors[0]?.message).toContain('key entry 1')
      expect(badEntry.errors[0]?.message).toContain('got 42')
    }
    const nul = compileRowDiffPlan(healthySchemaA, healthySchemaB, ['k\u0000ey'], healthyOptions)
    expect(nul.ok).toBe(false)
    if (!nul.ok) {
      expect(nul.errors.map((e) => e.code)).toEqual(['invalid-keys-input'])
      // never-echo: the offending name appears exactly (NUL included)
      expect(nul.errors[0]?.message).toContain("'k\u0000ey'")
    }
  })

  it('missing key columns are attributed per side, collected A-then-B, with a case-insensitive hint', () => {
    const result = compileRowDiffPlan(
      healthySchemaA,
      healthySchemaB,
      ['ghost', 'region', 'amount'],
      healthyOptions,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    // ghost missing on BOTH sides (A error before B error); region missing
    // only on A (it exists on B); amount missing only on B — all collected
    // in the documented order (key order, A before B within a key).
    expect(result.errors.map((e) => [e.code, e.side, e.column])).toEqual([
      ['missing-key-column', 'A', 'ghost'],
      ['missing-key-column', 'B', 'ghost'],
      ['missing-key-column', 'A', 'region'],
      ['missing-key-column', 'B', 'amount'],
    ])
    const ghostA = result.errors.find((e) => e.column === 'ghost' && e.side === 'A')
    expect(ghostA?.message).toContain('binding is exact and case-sensitive')
  })

  it('a near-miss key gets the case-insensitive "did you mean" hint when exactly one candidate exists', () => {
    const result = compileRowDiffPlan(
      [{ name: 'ID', type: 'BIGINT' }],
      [{ name: 'ID', type: 'BIGINT' }],
      ['id'],
      healthyOptions,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    const sideA = result.errors.find((e) => e.side === 'A')
    expect(sideA?.message).toContain("did you mean 'ID'")
  })

  it('zero shared columns → no-shared-columns plus the per-key missing errors it explains', () => {
    const result = compileRowDiffPlan(
      [{ name: 'a1', type: 'BIGINT' }],
      [{ name: 'b1', type: 'BIGINT' }],
      ['a1'],
      healthyOptions,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]?.code).toBe('no-shared-columns')
    expect(result.errors[0]?.message).toContain('side A has 1 columns, side B has 1')
    // a1 exists on side A, so exactly the B-side key error accompanies the
    // no-shared-columns diagnosis
    expect(result.errors.some((e) => e.code === 'missing-key-column' && e.side === 'A')).toBe(false)
    expect(result.errors.some((e) => e.code === 'missing-key-column' && e.side === 'B')).toBe(true)
  })

  it('schema problems fail the compile: unusable side, malformed entry, duplicate column', () => {
    const notArray = compileRowDiffPlan(null as never, healthySchemaB, ['id'], healthyOptions)
    expect(notArray.ok).toBe(false)
    if (!notArray.ok) {
      expect(notArray.errors.map((e) => e.code)).toEqual(['invalid-schema-input'])
      expect(notArray.errors[0]?.side).toBe('A')
    }
    const badEntry = compileRowDiffPlan(
      [{ name: '', type: 'BIGINT' }],
      healthySchemaB,
      ['id'],
      healthyOptions,
    )
    expect(badEntry.ok).toBe(false)
    if (!badEntry.ok) {
      expect(badEntry.errors[0]?.code).toBe('invalid-schema-input')
      expect(badEntry.errors[0]?.side).toBe('A')
    }
    const duplicate = compileRowDiffPlan(
      [
        { name: 'id', type: 'BIGINT' },
        { name: 'id', type: 'VARCHAR' },
      ],
      healthySchemaB,
      ['id'],
      healthyOptions,
    )
    expect(duplicate.ok).toBe(false)
    if (!duplicate.ok) {
      // stricter than the m6-0 report model (first-wins): binding refuses
      expect(duplicate.errors.map((e) => e.code)).toEqual(['duplicate-schema-column'])
      expect(duplicate.errors[0]?.column).toBe('id')
    }
    const nul = compileRowDiffPlan(
      [{ name: 'n\u0000ame', type: 'BIGINT' }],
      healthySchemaB,
      ['id'],
      healthyOptions,
    )
    expect(nul.ok).toBe(false)
    if (!nul.ok) expect(nul.errors[0]?.code).toBe('invalid-schema-input')
  })

  it('option problems are typed invalid-options, collected in the fixed read order', () => {
    // Fixed order: relationA, relationB, then sampleLimit — relation
    // problems collect together; the limit is validated once both
    // relations are clean (the m5-1 stage-wise precedent, documented).
    const empty = compileRowDiffPlan(healthySchemaA, healthySchemaB, ['id'], {
      relationA: '',
      relationB: 'b',
      sampleLimit: 0,
    })
    expect(empty.ok).toBe(false)
    if (!empty.ok) {
      expect(empty.errors.map((e) => e.code)).toEqual(['invalid-options'])
      expect(empty.errors[0]?.message).toContain("'relationA'")
    }
    const bothRelations = compileRowDiffPlan(healthySchemaA, healthySchemaB, ['id'], {
      relationA: '',
      relationB: '',
    })
    expect(bothRelations.ok).toBe(false)
    if (!bothRelations.ok) {
      expect(bothRelations.errors.map((e) => e.code)).toEqual([
        'invalid-options',
        'invalid-options',
      ])
      expect(bothRelations.errors[0]?.message).toContain("'relationA'")
      expect(bothRelations.errors[1]?.message).toContain("'relationB'")
    }
    const nul = compileRowDiffPlan(healthySchemaA, healthySchemaB, ['id'], {
      relationA: 'a',
      relationB: 'b\u0000b',
    })
    expect(nul.ok).toBe(false)
    if (!nul.ok) expect(nul.errors[0]?.message).toContain('NUL')
    const badLimit = compileRowDiffPlan(healthySchemaA, healthySchemaB, ['id'], {
      relationA: 'a',
      relationB: 'b',
      sampleLimit: 0,
    })
    expect(badLimit.ok).toBe(false)
    if (!badLimit.ok) expect(badLimit.errors[0]?.message).toContain('safe integer ≥ 1')
    // a throwing option getter degrades to the typed error, never a throw
    const throwing = compileRowDiffPlan(healthySchemaA, healthySchemaB, ['id'], {
      get relationA(): string {
        throw new Error('getter exploded')
      },
      relationB: 'b',
    } as never)
    expect(throwing.ok).toBe(false)
    if (!throwing.ok) {
      expect(throwing.errors.map((e) => e.code)).toEqual(['invalid-options'])
      expect(throwing.errors[0]?.message).toContain('threw an exception')
      expect(throwing.errors[0]?.message).not.toContain('exploded') // the thrown value is never interpolated
    }
  })

  it('errors are plain data and describeRowDiffBindingError renders a canonical one-liner', () => {
    const result = compileRowDiffPlan(healthySchemaA, healthySchemaB, ['ghost'], healthyOptions)
    expect(result.ok).toBe(false)
    if (result.ok) return
    for (const error of result.errors) {
      expect(JSON.parse(JSON.stringify(error))).toEqual(error)
      const rendered = describeRowDiffBindingError(error)
      expect(rendered).toContain(error.code)
      expect(rendered).toContain(`'${error.column}'`)
    }
    const error = result.errors[0] as (typeof result.errors)[number]
    expect(describeRowDiffBindingError(error)).toContain('[side A]')
    // total over a hostile error object, never-echo of unreadable parts
    expect(describeRowDiffBindingError(Object.create(null))).toContain('(unreadable)')
  })
})
