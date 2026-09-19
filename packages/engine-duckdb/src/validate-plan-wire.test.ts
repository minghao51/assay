import { describe, expect, it } from 'vitest'
import {
  assertValidationPlanRelationBinding,
  parseValidationPlan,
  quotedRelationToken,
} from './validate-plan-wire'
import type { EngineValidationPlan, EngineValidationRule } from './validate-plan-wire'

/**
 * A shape-valid v1 plan shaped exactly like the m5-1 compiler's output (the
 * conformance scenario also runs real compiler output through this parser —
 * these literals pin the boundary matrix in isolation).
 */
function validRule(overrides: Partial<EngineValidationRule> = {}): EngineValidationRule {
  return {
    ruleId: 'columns[0].required',
    path: 'columns[0].required',
    kind: 'required',
    column: 'id',
    outcome: 'row-samples',
    sql:
      'SELECT\n' +
      '  (SELECT count(*) FROM "v") AS "total_rows",\n' +
      '  count(*) OVER () AS "fail_count",\n' +
      '  row_number() OVER () - 1 AS "sample_index",\n' +
      '  "assay_row_ordinal",\n' +
      '  "assay_value"\n' +
      'FROM (\n' +
      '  SELECT row_number() OVER () - 1 AS "assay_row_ordinal", "src"."id" AS "assay_value"\n' +
      '  FROM "v" AS "src"\n' +
      ') AS "assay_rule_source"\n' +
      'WHERE "assay_value" IS NULL\n' +
      'LIMIT 20',
    ...overrides,
  }
}

function validPlan(overrides: Partial<EngineValidationPlan> = {}): EngineValidationPlan {
  return {
    planKind: 'assay-validation-plan',
    planVersion: 1,
    contractName: 'conf',
    contractVersion: 1,
    relation: 'assay_conf_validate_src',
    sampleLimit: 20,
    rules: [validRule()],
    summarySql:
      'SELECT \'columns[0].required\' AS "rule_id", (SELECT count(*) FROM "assay_conf_validate_src") AS "total_rows", count(*) AS "fail_count"\n' +
      'FROM "assay_conf_validate_src" AS "src"\n' +
      'WHERE "src"."id" IS NULL',
    ...overrides,
  }
}

describe('parseValidationPlan (m5-2 wire boundary)', () => {
  it('accepts a shape-valid v1 plan (a deep-equal copy, not the live object)', () => {
    const plan = validPlan()
    const parsed = parseValidationPlan(plan)
    expect(parsed).not.toBeNull()
    expect(parsed).toEqual(plan)
    expect(parsed).not.toBe(plan)
    // Rules are copied too: the request can never keep a reference into
    // worker state.
    expect(parsed?.rules[0]).not.toBe(plan.rules[0])
  })

  it('accepts a rule-less plan (the compiler emits an empty summary for it)', () => {
    const plan = validPlan({
      rules: [],
      summarySql: 'SELECT CAST(NULL AS VARCHAR) AS "rule_id" WHERE FALSE',
    })
    expect(parseValidationPlan(plan)).toEqual(plan)
  })

  it('rejects non-objects and a wrong discriminator/version', () => {
    expect(parseValidationPlan(null)).toBeNull()
    expect(parseValidationPlan('plan')).toBeNull()
    expect(parseValidationPlan(validPlan({ planKind: 'assay-validation-plan-v2' }))).toBeNull()
    expect(parseValidationPlan(validPlan({ planVersion: 2 }))).toBeNull()
  })

  it('rejects malformed metadata fields', () => {
    expect(parseValidationPlan(validPlan({ contractName: '' }))).toBeNull()
    expect(parseValidationPlan(validPlan({ contractName: 7 as unknown as string }))).toBeNull()
    expect(parseValidationPlan(validPlan({ contractVersion: 0 }))).toBeNull()
    expect(parseValidationPlan(validPlan({ contractVersion: 1.5 }))).toBeNull()
  })

  it('rejects malformed relation names (empty, non-string, NUL, over bound)', () => {
    expect(parseValidationPlan(validPlan({ relation: '' }))).toBeNull()
    expect(parseValidationPlan(validPlan({ relation: 9 as unknown as string }))).toBeNull()
    expect(parseValidationPlan(validPlan({ relation: 'a\u0000b' }))).toBeNull()
    expect(parseValidationPlan(validPlan({ relation: 'r'.repeat(129) }))).toBeNull()
    expect(parseValidationPlan(validPlan({ relation: 'r'.repeat(128) }))).not.toBeNull()
  })

  it('rejects sampleLimit below 1 or non-integer (the empty-result convention)', () => {
    expect(parseValidationPlan(validPlan({ sampleLimit: 0 }))).toBeNull()
    expect(parseValidationPlan(validPlan({ sampleLimit: -5 }))).toBeNull()
    expect(parseValidationPlan(validPlan({ sampleLimit: 2.5 }))).toBeNull()
    expect(parseValidationPlan(validPlan({ sampleLimit: '20' as unknown as number }))).toBeNull()
    // No upper bound: large K is legal upstream and clamped executor-side.
    expect(parseValidationPlan(validPlan({ sampleLimit: 10_000 }))).not.toBeNull()
  })

  it('rejects malformed rules and duplicate ruleIds (results key by ruleId)', () => {
    expect(
      parseValidationPlan(validPlan({ rules: ['nope'] as unknown as EngineValidationRule[] })),
    ).toBeNull()
    expect(
      parseValidationPlan(validPlan({ rules: [validRule({ kind: 'cross-field' })] })),
    ).toBeNull()
    expect(
      parseValidationPlan(validPlan({ rules: [validRule({ outcome: 'row-count' })] })),
    ).toBeNull()
    expect(parseValidationPlan(validPlan({ rules: [validRule({ sql: '' })] }))).toBeNull()
    expect(
      parseValidationPlan(validPlan({ rules: [validRule({ column: 5 as unknown as string })] })),
    ).toBeNull()
    expect(
      // expectedType/actualType are report attribution (never SQL positions
      // in the executor), so any bounded string parses.
      parseValidationPlan(validPlan({ rules: [validRule({ expectedType: 'BIGINT; DROP' })] })),
    ).not.toBeNull()
    expect(
      parseValidationPlan(
        validPlan({ rules: [validRule({ expectedType: 7 as unknown as string })] }),
      ),
    ).toBeNull()
    expect(parseValidationPlan(validPlan({ rules: [validRule(), validRule()] }))).toBeNull()
    expect(
      parseValidationPlan(
        validPlan({ rules: [validRule(), validRule({ ruleId: 'columns[0].unique' })] }),
      ),
    ).not.toBeNull()
  })

  it('rejects malformed or overlong summary SQL', () => {
    expect(parseValidationPlan(validPlan({ summarySql: '' }))).toBeNull()
    expect(parseValidationPlan(validPlan({ summarySql: 42 as unknown as string }))).toBeNull()
    expect(parseValidationPlan(validPlan({ summarySql: 'S'.repeat(100_001) }))).toBeNull()
    expect(parseValidationPlan(validPlan({ summarySql: 'S'.repeat(100_000) }))).not.toBeNull()
  })
})

describe('assertValidationPlanRelationBinding (executor-side semantic gate)', () => {
  it('accepts the compiler-shaped FROM renderings', () => {
    expect(() => assertValidationPlanRelationBinding(validPlan(), ['assay_t1'])).not.toThrow()
    const emptySummary = validPlan({
      rules: [],
      summarySql: 'SELECT CAST(NULL AS VARCHAR) AS "rule_id" WHERE FALSE',
    })
    expect(() => assertValidationPlanRelationBinding(emptySummary, [])).not.toThrow()
  })

  it('rejects a relation equal to a registered view name (no shadowing)', () => {
    const plan = validPlan({ relation: 'assay_t1' })
    expect(() => assertValidationPlanRelationBinding(plan, ['assay_t1', 'assay_t2'])).toThrow(
      /collides with a registered table view/,
    )
    // The same plan passes when that view is not registered (the executor
    // also relies on bare CREATE VIEW failing on any other catalog object).
    expect(() => assertValidationPlanRelationBinding(plan, ['assay_t2'])).not.toThrow()
  })

  it('rejects relation tokens outside the compiler FROM shape (smuggled SQL)', () => {
    const smuggled = validPlan({
      rules: [
        validRule({
          ruleId: 'hostile',
          sql: 'SELECT 1 FROM "assay_conf_validate_src"; CREATE TABLE evil AS SELECT 2',
        }),
      ],
    })
    expect(() => assertValidationPlanRelationBinding(smuggled, [])).toThrow(
      /does not bind its relation in the compiler's FROM shape/,
    )
    // A quoted-relation occurrence in a predicate position is also rejected.
    const predicate = validPlan({
      rules: [
        validRule({
          ruleId: 'hostile-where',
          sql: 'SELECT 1 AS "total_rows", 1 AS "fail_count" WHERE "assay_conf_validate_src" IS NULL',
        }),
      ],
    })
    expect(() => assertValidationPlanRelationBinding(predicate, [])).toThrow(/FROM shape/)
    // And in the summary.
    const summary = validPlan({
      summarySql: 'SELECT 1 AS "x" WHERE "assay_conf_validate_src" IS NOT NULL',
    })
    expect(() => assertValidationPlanRelationBinding(summary, [])).toThrow(/FROM shape/)
  })

  it('rejects a relation occurrence missing the FROM prefix even with a valid suffix', () => {
    const prefix = validPlan({
      rules: [
        validRule({ sql: 'SELECT "assay_conf_validate_src" AS "assay_value" FROM "v" AS "src"' }),
      ],
    })
    expect(() => assertValidationPlanRelationBinding(prefix, [])).toThrow(/FROM shape/)
  })
})

describe('quotedRelationToken', () => {
  it('matches the compiler identifier quoting (double-quote doubling)', () => {
    expect(quotedRelationToken('v')).toBe('"v"')
    expect(quotedRelationToken('we"ird')).toBe('"we""ird"')
  })
})
