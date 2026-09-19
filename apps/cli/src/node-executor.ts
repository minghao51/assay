/**
 * The Node executor (m5-4): run a compiled m5-1 `ValidationPlan` against a
 * registered dataset view over a `@duckdb/node-api` connection, REUSING the
 * engine-neutral validate helpers from `@assay/engine-duckdb` — view
 * composition (`composeValidationViewSql`), the engine-clamped rule-query
 * wrapper (`composeValidationRuleQuery` + `validationEffectiveSampleLimit`),
 * the wire gate (`parseValidationPlan` + `assertValidationPlanRelationBinding`),
 * the result readers (`readValidation*`), and the frozen exact `failPercent`
 * (`failPercentFromCounts`). The plan SQL is executed BYTE-IDENTICALLY on both
 * surfaces (m5-2's cross-surface agreement discipline) — this module never
 * rewrites it.
 *
 * ## Scope honesty (ADR 0040 / m5-4)
 *
 * The CLI validates the **base view only**: the raw dataset file, no overlay.
 * There is no editing session on this surface, so the composition is the
 * engine's `baseViewComposition` shape (empty anchors, empty overlay state)
 * and the row keys are the empty-anchor grammar `base:#<ordinal>`. In-flight
 * edits live in the web surface's overlay and are deliberately out of scope
 * here — the JSON report says so (`baseViewOnly: true`, `stale: false`).
 *
 * This module mirrors the engine executor's CONTAINMENT posture for the base
 * path: the run sits inside a `BEGIN … ROLLBACK` transaction (belt 2 of the
 * m5-2 fix round — DDL is transactional, so nothing persists), the binding
 * view is dropped inside the transaction before the rollback, the plan passes
 * the static relation-binding gate before any SQL runs, and the per-rule
 * sanity guards (failCount ≤ rowCount, samples ≤ clamp, summary agreement)
 * all fail loudly instead of reporting an out-of-contract result.
 *
 * ## The value-transport seam (why this module owns an Arrow conversion)
 *
 * The engine's result readers consume Apache Arrow tables (`table.getChild`,
 * vector `get`). The web engine transports Arrow IPC from DuckDB-WASM; the
 * `@duckdb/node-api` backend instead materializes JS values. The bridge is
 * THIS module's `readerToArrowTable`: each result column becomes an Arrow
 * vector of the type the engine's readers expect, with a documented,
 * deliberate value mapping (see `toArrowValue`):
 *
 * - BIGINT/HUGEINT (JS `bigint`) → Arrow int64 — the engine's
 *   `normalizeSampleValue` then yields a JS number when the value is a safe
 *   integer, else its exact decimal TEXT (the wasm path's contract);
 * - INTEGER/DOUBLE/FLOAT (JS `number`) → Arrow float64 (verbatim);
 * - DECIMAL (a `DuckDBDecimalValue`) → exact scaled TEXT, or a number when
 *   the value is a safe integer — the same decision the wasm decimal-object
 *   path makes through `normalizeSampleValue`;
 * - VARCHAR → Arrow utf8; BOOLEAN → Arrow bool; BLOB (a `Buffer`) → Arrow
 *   binary (normalized to hex text, as on the web);
 * - NULL-only columns → Arrow utf8 (the readers' shape checks run first).
 *
 * Known, documented variance (pinned honestly, not hidden): a numeric column
 * (DECIMAL/HUGEINT) whose values STRADDLE the safe-integer boundary would be
 * normalized per-value (mixed number/text) on the web and can only be carried
 * here as one Arrow column — such a column is rendered as exact TEXT for ALL
 * of its values. Values within a single column are homogeneous, so this needs
 * a decimal/hugeint column spanning ±2⁵³ to observe; the agreement test's
 * dataset (BIGINT/VARCHAR/HUGEINT/DOUBLE/BOOLEAN, all within the safe range)
 * is byte-agreement-exact.
 */
import {
  Binary,
  BinaryBuilder,
  Bool,
  BoolBuilder,
  Float64,
  Float64Builder,
  Int64,
  Int64Builder,
  Utf8,
  Utf8Builder,
  tableFromArrays,
} from 'apache-arrow'
import type { Table, Vector } from 'apache-arrow'
import { DuckDBDecimalValue } from '@duckdb/node-api'
import type { DuckDBConnection, DuckDBResultReader } from '@duckdb/node-api'
import {
  VALIDATION_BEGIN_SQL,
  VALIDATION_ROLLBACK_SQL,
  assertValidationPlanRelationBinding,
  buildSampleFailures,
  composeValidationCountSql,
  composeValidationRowKeySql,
  composeValidationRuleQuery,
  composeValidationViewDropSql,
  composeValidationViewSql,
  failPercentFromCounts,
  parseValidationPlan,
  readValidationRowCount,
  readValidationRuleRows,
  readValidationRowKeys,
  readValidationSummaryRows,
  validationEffectiveSampleLimit,
} from '@assay/engine-duckdb/node'
import type {
  EngineValidationPlan,
  EngineValidationResult,
  EngineValidationRuleResult,
} from '@assay/engine-duckdb/node'
import { initialState } from '@assay/domain'
import type { OverlayBase } from '@assay/domain'
import type { EngineSchema } from '@assay/validation'
import { DATASET_VIEW, PLAN_RELATION } from './connection'
import { usageError } from './errors'

/**
 * Wire-harden a freshly compiled plan (the m5-2 boundary discipline: the
 * compiler's output is the ONLY thing this surface executes, and it must pass
 * the same structural gate the engine's worker applies) and run the static
 * relation-binding gate against the CLI's registered view names.
 *
 * A compiler-produced plan that fails the wire is an internal inconsistency,
 * never a user-facing state, so it surfaces as the fixed
 * `plan rejected by the wire gate` usage error.
 */
export function preparePlan(
  compiledPlan: unknown,
  registeredViewNames: readonly string[],
): EngineValidationPlan {
  const plan = parseValidationPlan(compiledPlan)
  if (plan === null) {
    throw usageError('internal error: the compiled plan was rejected by the wire gate')
  }
  assertValidationPlanRelationBinding(plan, registeredViewNames)
  return plan
}

/**
 * Execute an already-prepared plan (see {@link preparePlan}) against the base
 * view (the engine executor's base path, minus the worker protocol).
 * Engine-touching failures are mapped to fixed, value-free failure classes
 * (the m5-2 privacy discipline: DuckDB's own messages can embed values, so
 * they never reach stderr verbatim).
 */
export async function runValidationPlan(
  conn: DuckDBConnection,
  plan: EngineValidationPlan,
  schema: EngineSchema,
): Promise<EngineValidationResult> {
  const effectiveLimit = validationEffectiveSampleLimit(plan.sampleLimit)

  // The base-view composition (engine `baseViewComposition` shape): DESCRIBE
  // supplies the columns; the empty state adds no overlay machinery.
  const base: OverlayBase = {
    baseAnchor: '',
    overlayAnchor: '',
    columns: schema.map((column) => ({ name: column.name, type: column.type })),
    baseRowCount: 0,
  }
  const composition = { viewName: DATASET_VIEW, base, state: initialState(base) }

  // Defense-in-depth re-check of the static gate (the caller already ran it
  // via preparePlan; the containment posture wants it adjacent to execution).
  assertValidationPlanRelationBinding(plan, [DATASET_VIEW])

  await step('the validation containment transaction could not be started', () =>
    conn.run(VALIDATION_BEGIN_SQL),
  )
  let viewCreated = false
  try {
    await step('the validation binding view could not be materialized', () =>
      conn.run(composeValidationViewSql(composition, plan.relation)),
    )
    viewCreated = true

    const rowCount = readValidationRowCount(
      readerToArrowTable(
        await step('the row-count query failed to execute', () =>
          conn.runAndReadAll(composeValidationCountSql(plan.relation)),
        ),
      ),
    )

    const ordinals = new Set<number>()
    const perRule: {
      ruleId: string
      failCount: number
      samples: ReturnType<typeof readValidationRuleRows>['samples']
    }[] = []
    for (const rule of plan.rules) {
      const rows = readValidationRuleRows(
        readerToArrowTable(
          await step(`validation rule '${rule.ruleId}' failed to execute`, () =>
            conn.runAndReadAll(composeValidationRuleQuery(rule.sql, effectiveLimit)),
          ),
        ),
        rule.outcome,
      )
      // Result sanity, mirroring the engine executor: a violation count
      // larger than the row count cannot be compiler output, and samples
      // never exceed the engine clamp or reference past-the-end ordinals.
      if (rows.failCount > rowCount) {
        throw usageError(
          `validation rule '${rule.ruleId}' reported more failures than rows in the dataset`,
        )
      }
      if (rows.samples.length > effectiveLimit) {
        throw usageError(`validation rule '${rule.ruleId}' returned more samples than its bound`)
      }
      for (const sample of rows.samples) {
        if (sample.ordinal >= rowCount) {
          throw usageError(`validation rule '${rule.ruleId}' sampled past the end of the dataset`)
        }
        ordinals.add(sample.ordinal)
      }
      perRule.push({ ruleId: rule.ruleId, failCount: rows.failCount, samples: rows.samples })
    }

    const keys =
      ordinals.size > 0
        ? readValidationRowKeys(
            readerToArrowTable(
              await step('the row-key query failed to execute', () =>
                conn.runAndReadAll(
                  composeValidationRowKeySql(
                    plan.relation,
                    [...ordinals].sort((a, b) => a - b),
                  ),
                ),
              ),
            ),
          )
        : new Map<number, string>()

    const summary = readValidationSummaryRows(
      readerToArrowTable(
        await step('the validation summary query failed to execute', () =>
          conn.runAndReadAll(plan.summarySql),
        ),
      ),
    )
    if (summary.size !== plan.rules.length) {
      throw usageError('the validation summary did not report one row per planned rule')
    }

    const rules: EngineValidationRuleResult[] = perRule.map((rule) => {
      const summaryCount = summary.get(rule.ruleId)
      if (summaryCount === undefined) {
        throw usageError(`the validation summary is missing rule '${rule.ruleId}'`)
      }
      if (summaryCount !== rule.failCount) {
        throw usageError(
          `the validation summary disagrees with the per-rule count for '${rule.ruleId}'`,
        )
      }
      return {
        ruleId: rule.ruleId,
        failCount: rule.failCount,
        failPercent: failPercentFromCounts(rule.failCount, rowCount),
        sampleFailures: buildSampleFailures(rule.samples, keys),
      }
    })

    return {
      valid: rules.every((rule) => rule.failCount === 0),
      rowCount,
      rules,
    }
  } finally {
    // Containment cleanup, ALWAYS both steps in order (the engine's W2
    // discipline): drop only what this run created, then roll back. The
    // rollback undoes the transaction regardless of the drop's outcome.
    let dropError: Error | null = null
    if (viewCreated) {
      try {
        await conn.run(composeValidationViewDropSql(plan.relation))
      } catch (error) {
        dropError = error instanceof Error ? error : null
      }
    }
    await conn.run(VALIDATION_ROLLBACK_SQL).catch(() => undefined)
    // A failed drop cannot mask the run's result (the rollback still ran);
    // the next op on this connection fails cleanly if the catalog is dirty.
    if (dropError !== null && viewCreated) {
      // Best-effort only: the transaction is already rolled back, so the
      // dropped-view failure cannot persist state (DDL was never committed).
    }
  }
}

/**
 * One engine-touching step, mapped to a fixed value-free failure class (the
 * m5-2 `validationStep` posture): the raw error is dropped, the plan SQL is
 * never echoed, and only the authored class message surfaces.
 */
async function step<T>(failureClass: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch {
    throw usageError(failureClass)
  }
}

/** Builder options: treat null/undefined as the validity bitmap's null. */
const BUILDER_NULLS = { nullValues: [null, undefined] } as const

/** The int64 bounds — bigint values outside Arrow int64 cannot be carried. */
const INT64_MAX = 9223372036854775807n
const INT64_MIN = -9223372036854775808n

/**
 * Convert one raw DuckDB value to the value an Arrow vector of the column's
 * chosen type carries (see the module doc for the full mapping contract).
 */
function toArrowValue(value: unknown): bigint | number | string | boolean | Uint8Array | null {
  if (value === null || value === undefined) return null
  switch (typeof value) {
    case 'bigint':
      if (value > INT64_MAX || value < INT64_MIN) {
        // Outside Arrow int64: the exact decimal TEXT is the only lossless
        // Arrow-carriable form (normalizeSampleValue passes text verbatim).
        return value.toString()
      }
      return value
    case 'number':
      return value
    case 'string':
      return value
    case 'boolean':
      return value
    case 'object':
      if (value instanceof Uint8Array) return value
      if (value instanceof DuckDBDecimalValue) {
        // The exact scaled text ('1.500'), or a number when the value is a
        // safe integer — the same decision the wasm decimal path makes.
        const text = String(value)
        const asNumber = Number(text)
        return Number.isSafeInteger(asNumber) ? asNumber : text
      }
      break
    default:
      break
  }
  throw new Error('a result value had an unsupported shape for the Node backend')
}

/** The non-null value kinds a converted column can carry. */
type ArrowValue = Exclude<ReturnType<typeof toArrowValue>, null>

/**
 * Build one named Arrow vector for a converted column. The Arrow type is
 * chosen from the column's whole converted value set (DuckDB columns are
 * homogeneous, so the set is homogeneous modulo the documented int64-overflow
 * text fallback): text present → Utf8; else bigint → Int64; else number →
 * Float64; else boolean → Bool; else binary → Binary; an all-null column →
 * Utf8 nulls (the engine's shape checks run before any value is read).
 */
function buildColumnVector(values: readonly (ArrowValue | null)[]): Vector {
  const present = values.filter((value): value is ArrowValue => value !== null)
  const hasText = present.some((value) => typeof value === 'string')
  const hasBigint = present.some((value) => typeof value === 'bigint')
  const hasNumber = present.some((value) => typeof value === 'number')
  const hasBoolean = present.some((value) => typeof value === 'boolean')
  const hasBytes = present.some((value) => value instanceof Uint8Array)

  if (hasText) {
    const builder = new Utf8Builder({ type: new Utf8(), ...BUILDER_NULLS })
    for (const value of values) {
      // Defensive String() for non-text values in a text column: DuckDB
      // columns are homogeneous, so this only ever covers the int64-overflow
      // text fallback (and can only mix with numbers in a degenerate engine
      // deviation the readers fail on downstream).
      builder.append(value === null || typeof value === 'string' ? value : String(value))
    }
    builder.finish()
    return builder.toVector()
  }
  if (hasBigint) {
    const builder = new Int64Builder({ type: new Int64(), ...BUILDER_NULLS })
    for (const value of values) {
      builder.append(
        value === null ? null : typeof value === 'bigint' ? value : BigInt(String(value)),
      )
    }
    builder.finish()
    return builder.toVector()
  }
  if (hasNumber) {
    const builder = new Float64Builder({ type: new Float64(), ...BUILDER_NULLS })
    for (const value of values) {
      builder.append(value === null ? null : typeof value === 'number' ? value : Number(value))
    }
    builder.finish()
    return builder.toVector()
  }
  if (hasBoolean) {
    const builder = new BoolBuilder({ type: new Bool(), ...BUILDER_NULLS })
    for (const value of values) {
      builder.append(value === null ? null : typeof value === 'boolean' ? value : null)
    }
    builder.finish()
    return builder.toVector()
  }
  if (hasBytes) {
    const builder = new BinaryBuilder({ type: new Binary(), ...BUILDER_NULLS })
    for (const value of values) {
      builder.append(value instanceof Uint8Array ? value : null)
    }
    builder.finish()
    return builder.toVector()
  }
  const builder = new Utf8Builder({ type: new Utf8(), ...BUILDER_NULLS })
  builder.finish()
  return builder.toVector()
}

/**
 * Convert a node-api result reader into the Arrow table shape the engine's
 * readers consume: named columns, one vector per column, values mapped
 * through {@link toArrowValue} and {@link buildColumnVector}. The cast at the
 * table boundary is structural: apache-arrow v17's `tableFromArrays` types
 * accept arrays/typed arrays but (unlike its runtime) not `Vector` inputs.
 */
export function readerToArrowTable(reader: DuckDBResultReader): Table {
  const names = reader.columnNames()
  const rows = reader.getRowObjects()
  const columns: Record<string, Vector> = {}
  for (const name of names) {
    columns[name] = buildColumnVector(rows.map((row) => toArrowValue(row[name] ?? null)))
  }
  return tableFromArrays(columns as unknown as Record<string, readonly unknown[]>)
}

/** The binding relation the CLI's plans compile against (re-exported). */
export { PLAN_RELATION }
