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
 * sanity guards (the per-outcome failCount bound — row counts for row-samples
 * rules, ONE for dataset-fact facts, m5-4; samples ≤ clamp; summary
 * agreement) all fail loudly instead of reporting an out-of-contract result.
 * The failCount bound and its message come from the shared seam
 * (`validationFailCountExcess`) — the CLI mirrors the engine's check by
 * construction, not by re-derivation.
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
 *   the value is an integer within the safe range — the same decision the
 *   wasm decimal-object path makes.
 * - VARCHAR → Arrow utf8; BOOLEAN → Arrow bool; BLOB (a `Buffer`) → Arrow
 *   binary (normalized to hex text, as on the web);
 * - NULL-only columns → Arrow utf8 (the readers' shape checks run first).
 *
 * Known, documented variance (pinned honestly, not hidden; audit AR-C5):
 * the DECIMAL text/number toggle is **integer-valued vs fractional**, per
 * value — `5::DECIMAL(10,0)` reads as a number; `1.5::DECIMAL(10,1)` reads
 * as exact text even far from ±2⁵³ — and `buildColumnVector` types a
 * column from its whole value set (text present → Utf8), so any **mixed**
 * column (e.g. integers and fractions side by side, or integers straddling
 * ±2⁵³) is carried as exact TEXT for ALL of its values. The cross-surface
 * agreement suite has no DECIMAL leg yet; a fractional or straddling
 * decimal column is where web and CLI reports can legitimately differ in
 * number-vs-text rendering while staying value-exact.
 */
import {
  Binary,
  BinaryBuilder,
  Bool,
  BoolBuilder,
  Field,
  Float64,
  Float64Builder,
  Int64,
  Int64Builder,
  List,
  Utf8,
  Utf8Builder,
  tableFromArrays,
  vectorFromArray,
} from 'apache-arrow'
import type { Table, Vector } from 'apache-arrow'
import { DuckDBArrayValue, DuckDBDecimalValue, DuckDBListValue } from '@duckdb/node-api'
import type { DuckDBConnection, DuckDBResultReader } from '@duckdb/node-api'
import {
  ROW_DIFF_BEGIN_SQL,
  ROW_DIFF_ROLLBACK_SQL,
  VALIDATION_BEGIN_SQL,
  VALIDATION_ROLLBACK_SQL,
  assertRowDiffPlanBinding,
  assertValidationPlanRelationBinding,
  buildDiffAspectSamples,
  buildSampleFailures,
  classifyProfileColumnType,
  composeDiffARowKeySql,
  composeDiffAspectQuery,
  composeDiffAViewSql,
  composeDiffComparisonViewSql,
  composeDiffCountSql,
  composeDiffViewDropSql,
  composeProfileBaseSql,
  composeProfileTopKSql,
  composeValidationCountSql,
  composeValidationRowKeySql,
  composeValidationRuleQuery,
  composeValidationViewDropSql,
  composeValidationViewSql,
  diffEffectiveSampleLimit,
  failPercentFromCounts,
  parseRowDiffPlan,
  parseValidationPlan,
  PROFILE_BASE_SLOT,
  readDiffARowKeys,
  readDiffAspectRows,
  readDiffRowCount,
  readDiffTotalsRows,
  readValidationRowCount,
  readValidationRuleRows,
  readValidationRowKeys,
  readValidationSummaryRows,
  rowDiffCountExcess,
  validationEffectiveSampleLimit,
  validationFailCountExcess,
} from '@assay/engine-duckdb/node'
import type {
  EngineRowDiffAspect,
  EngineRowDiffPlan,
  EngineRowDiffResult,
  EngineValidationPlan,
  EngineValidationResult,
  EngineValidationRuleResult,
  RowDiffSampleRow,
} from '@assay/engine-duckdb/node'
import { initialState } from '@assay/domain'
import type { OverlayBase } from '@assay/domain'
import type { CategoricalTopKEntry, DatasetProfile, NumericQuantiles } from '@assay/diff'
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
      outcome: string
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
      // Result sanity, mirroring the engine executor through the shared
      // seam: the reported count must fit the rule's OUTCOME bound —
      // row-samples counts are bounded by the dataset's row count;
      // dataset-fact counts by ONE (a boolean fact holds or fails, never
      // "fails twice": `dataset.min-rows ≥ 1` over an empty dataset is an
      // honest VIOLATION on this surface — exit 1 with the fact in the
      // report — never an execution error). Samples never exceed the
      // engine clamp or reference past-the-end ordinals.
      const excess = validationFailCountExcess(rows.failCount, rowCount, rule.outcome)
      if (excess !== null) {
        throw usageError(`validation rule '${rule.ruleId}' ${excess}`)
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
      perRule.push({
        ruleId: rule.ruleId,
        outcome: rule.outcome,
        failCount: rows.failCount,
        samples: rows.samples,
      })
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
        outcome: rule.outcome,
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

/**
 * Build the m2-shaped `DatasetProfile` for a registered view (m6-3): the m2-5
 * combined aggregate (REUSED `composeProfileBaseSql` from the `./node` seam)
 * plus one top-k query per categorical column (REUSED
 * `composeProfileTopKSql`). The schema is the `DESCRIBE` shape the caller
 * already read; only the value reading is host-side, exactly like the m5-4
 * Arrow bridge. The SQL composition is engine-owned and never forked, so a
 * CLI profile is byte-identical to the one the web engine builds.
 *
 * Classify through the REUSED `classifyProfileColumnType` — a column this
 * binary cannot classify grades to `other` (name/type/nullCount/
 * distinctCount only), matching the engine's graceful degradation.
 */
export async function profileView(
  conn: DuckDBConnection,
  viewName: string,
  schema: EngineSchema,
): Promise<DatasetProfile> {
  const specs = schema.map((column) => ({
    name: column.name,
    kind: classifyProfileColumnType(column.type),
  }))
  const base = composeProfileBaseSql({ viewName, columns: specs })
  const baseReader = await step('the profile aggregate failed to execute', () =>
    conn.runAndReadAll(base.sql),
  )
  const baseRow = baseReader.getRowObjects()[0]
  if (baseRow === undefined) {
    throw usageError('the profile aggregate returned an unexpected shape')
  }
  const slot = (index: number): unknown => baseRow[`c${String(index)}`]
  const rowCount = readProfileCount(slot(0))
  const columns: DatasetProfile['columns'] = schema.map((column, index) => {
    const kind = specs[index]!.kind
    const offset = base.offsets[index]!
    const nonNull = readProfileCount(slot(offset + PROFILE_BASE_SLOT.nonNull))
    const profileColumn: DatasetProfile['columns'][number] = {
      name: column.name,
      type: column.type,
      kind,
      nullCount: rowCount - nonNull,
      distinctCount: readProfileCount(slot(offset + PROFILE_BASE_SLOT.distinct)),
    }
    if (kind === 'numeric') {
      profileColumn.numeric = {
        min: readProfileStat(slot(offset + PROFILE_BASE_SLOT.min)),
        max: readProfileStat(slot(offset + PROFILE_BASE_SLOT.max)),
        mean: readProfileStat(slot(offset + PROFILE_BASE_SLOT.mean)),
        stddev: readProfileStat(slot(offset + PROFILE_BASE_SLOT.stddev)),
        quantiles: readProfileQuantiles(slot(offset + PROFILE_BASE_SLOT.quantiles)),
      }
    }
    return profileColumn
  })
  for (let index = 0; index < columns.length; index++) {
    if (specs[index]!.kind !== 'categorical') continue
    columns[index]!.categorical = { topK: await readTopK(conn, viewName, specs[index]!.name) }
  }
  return { rowCount, columns }
}

/** Read one categorical column's top-k (≤ k rows; NULLs excluded by the SQL). */
async function readTopK(
  conn: DuckDBConnection,
  viewName: string,
  column: string,
): Promise<CategoricalTopKEntry[]> {
  const reader = await step('the profile top-k query failed to execute', () =>
    conn.runAndReadAll(composeProfileTopKSql({ viewName, column })),
  )
  const topK: CategoricalTopKEntry[] = []
  for (const row of reader.getRowObjects()) {
    const value = row['v']
    if (typeof value !== 'string') {
      throw usageError('the profile top-k value was not rendered text')
    }
    topK.push({ value, count: readProfileCount(row['n']) })
  }
  return topK
}

/** A profile count slot (BIGINT from node-api) as a safe non-negative integer. */
function readProfileCount(value: unknown): number {
  const n = typeof value === 'bigint' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) {
    throw usageError('the profile aggregate returned an unexpected shape')
  }
  return n
}

/** A profile numeric stat slot: finite JS number or null (the engine contract). */
function readProfileStat(value: unknown): number | null {
  const n = typeof value === 'bigint' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

/** A DuckDB LIST/ARRAY cell's items (empty for a NULL cell; the engine contract). */
function readProfileListItems(value: unknown): readonly unknown[] {
  if (value === null || value === undefined) return []
  if (value instanceof DuckDBListValue || value instanceof DuckDBArrayValue) return value.items
  if (Array.isArray(value)) return value
  throw usageError('the profile aggregate returned an unexpected shape')
}

/** The DOUBLE[4] quantile slot (p50, p90, p95, p99 — the composer's fixed order). */
function readProfileQuantiles(value: unknown): NumericQuantiles {
  if (value === null || value === undefined) {
    return { p50: null, p90: null, p95: null, p99: null }
  }
  const items = readProfileListItems(value)
  if (items.length !== 4) {
    throw usageError('the profile quantile aggregate returned an unexpected shape')
  }
  return {
    p50: readProfileStat(items[0]),
    p90: readProfileStat(items[1]),
    p95: readProfileStat(items[2]),
    p99: readProfileStat(items[3]),
  }
}

/**
 * Wire-harden a freshly compiled m6-1 row-diff plan (the m6-2 two-belt gate:
 * the CLI must not bypass or re-implement it — the plan passes the same
 * structural parser and binding assertions the engine's worker applies, so
 * every surface executes the same plans). A compiler-produced plan that
 * fails the wire is an internal inconsistency, never a user-facing state.
 */
export function prepareDiffPlan(
  compiledPlan: unknown,
  registeredViewNames: readonly string[],
): EngineRowDiffPlan {
  const plan = parseRowDiffPlan(compiledPlan)
  if (plan === null) {
    throw usageError('internal error: the compiled row-diff plan was rejected by the wire gate')
  }
  assertRowDiffPlanBinding(plan, registeredViewNames)
  return plan
}

/**
 * Execute an already-prepared row-diff plan (m6-3) against side A's BASE view
 * (the CLI has no editing session, like m5-4) and side B's registered view,
 * mirroring the engine's m6-2 `runDiff` op minus the worker transport: the
 * plan's SQL is executed byte-identically behind only the clamp wrapper, both
 * binding views are materialized under the plan's own relation names, every
 * sampled A-side ordinal resolves to its logical `base:#<ordinal>` key, and
 * the whole op is contained in a `BEGIN … ROLLBACK` transaction whose views
 * are always dropped. Result-sanity bounds and the per-aspect ≡ totals net
 * come from the shared `./node` seam (`rowDiffCountExcess`, `readDiffTotalsRows`),
 * so a corrupt result fails loudly instead of being reported.
 *
 * Privacy (ADR 0025): raw engine errors are dropped here (DuckDB text can
 * embed values) and replaced by fixed, value-free failure classes.
 */
export async function runDiffPlan(
  conn: DuckDBConnection,
  plan: EngineRowDiffPlan,
  schemaA: EngineSchema,
  stagedViewB: string,
): Promise<EngineRowDiffResult> {
  const effectiveLimit = diffEffectiveSampleLimit(plan.sampleLimit)
  // The base-view composition (the engine's base path): DESCRIBE supplies the
  // columns; the empty state adds no overlay machinery.
  const base: OverlayBase = {
    baseAnchor: '',
    overlayAnchor: '',
    columns: schemaA.map((column) => ({ name: column.name, type: column.type })),
    baseRowCount: 0,
  }
  const composition = { viewName: DATASET_VIEW, base, state: initialState(base) }

  // Defense-in-depth re-check of the static gate adjacent to execution.
  assertRowDiffPlanBinding(plan, [DATASET_VIEW, stagedViewB])

  await step('the row-diff containment transaction could not be started', () =>
    conn.run(ROW_DIFF_BEGIN_SQL),
  )
  let aViewCreated = false
  let bViewCreated = false
  try {
    await step('the row-diff side A binding view could not be materialized', () =>
      conn.run(composeDiffAViewSql(composition, plan.relationA)),
    )
    aViewCreated = true
    await step('the row-diff side B binding view could not be materialized', () =>
      conn.run(composeDiffComparisonViewSql(plan.relationB, stagedViewB)),
    )
    bViewCreated = true

    const rowCountA = readDiffRowCount(
      readerToArrowTable(
        await step('the row-diff side A count query failed to execute', () =>
          conn.runAndReadAll(composeDiffCountSql(plan.relationA)),
        ),
      ),
    )
    const rowCountB = readDiffRowCount(
      readerToArrowTable(
        await step('the row-diff side B count query failed to execute', () =>
          conn.runAndReadAll(composeDiffCountSql(plan.relationB)),
        ),
      ),
    )

    const aspectOrder: readonly EngineRowDiffAspect[] = ['added', 'removed', 'changed']
    const aspectSqls: Readonly<Record<EngineRowDiffAspect, string>> = {
      added: plan.addedSql,
      removed: plan.removedSql,
      changed: plan.changedSql,
    }
    const rowsByAspect = new Map<EngineRowDiffAspect, readonly RowDiffSampleRow[]>()
    const counts = new Map<EngineRowDiffAspect, number>()
    const aOrdinals = new Set<number>()
    for (const aspect of aspectOrder) {
      const rows = await step(`row-diff ${aspect} query failed to execute`, async () =>
        readDiffAspectRows(
          readerToArrowTable(
            await conn.runAndReadAll(composeDiffAspectQuery(aspectSqls[aspect], effectiveLimit)),
          ),
          aspect,
        ),
      )
      const excess = rowDiffCountExcess(aspect, rows.count, rowCountA, rowCountB)
      if (excess !== null) {
        throw usageError(`row-diff ${aspect} ${excess}`)
      }
      if (rows.rows.length > effectiveLimit) {
        throw usageError(`row-diff ${aspect} returned more samples than the engine's bound`)
      }
      for (const sample of rows.rows) {
        if (sample.side === 'A') {
          if (sample.ordinal >= rowCountA) {
            throw usageError(
              `row-diff ${aspect} sampled an A-side ordinal past the effective row count`,
            )
          }
          aOrdinals.add(sample.ordinal)
        } else if (sample.ordinal >= rowCountB) {
          throw usageError(
            `row-diff ${aspect} sampled a B-side ordinal past the comparison row count`,
          )
        }
      }
      counts.set(aspect, rows.count)
      rowsByAspect.set(aspect, rows.rows)
    }

    const aKeys =
      aOrdinals.size > 0
        ? await step('the row-diff side A row-key query failed to execute', async () =>
            readDiffARowKeys(
              readerToArrowTable(
                await conn.runAndReadAll(
                  composeDiffARowKeySql(
                    plan.relationA,
                    [...aOrdinals].sort((a, b) => a - b),
                  ),
                ),
              ),
            ),
          )
        : new Map<number, string>()

    const totals = await step('the row-diff totals query failed to execute', async () =>
      readDiffTotalsRows(readerToArrowTable(await conn.runAndReadAll(plan.totalsSql))),
    )

    const aspects: EngineRowDiffResult['aspects'] = aspectOrder.map((aspect) => {
      const rows = rowsByAspect.get(aspect) ?? []
      const count = counts.get(aspect) ?? 0
      const totalCount = totals.get(aspect)
      if (totalCount === undefined) {
        throw usageError(`row-diff totals query is missing the ${aspect} aspect`)
      }
      if (totalCount !== count) {
        throw usageError(`row-diff totals query disagrees with the ${aspect} count`)
      }
      return { aspect, count, samples: buildDiffAspectSamples(rows, aspect, aKeys) }
    })
    return { rowCountA, rowCountB, aspects }
  } finally {
    // Containment cleanup, always both drops then the rollback (the m6-2 W2
    // ordering). A failed drop cannot mask the run's result: the transaction
    // is rolled back regardless.
    if (aViewCreated) {
      await conn.run(composeDiffViewDropSql(plan.relationA)).catch(() => undefined)
    }
    if (bViewCreated) {
      await conn.run(composeDiffViewDropSql(plan.relationB)).catch(() => undefined)
    }
    await conn.run(ROW_DIFF_ROLLBACK_SQL).catch(() => undefined)
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
 *
 * m6-3 adds one value family: DuckDB LIST/ARRAY cells (the row-diff
 * `assay_changed` VARCHAR[] column, read by the engine's `readStringListCell`)
 * become an array of rendered text entries. apache-arrow v17 cannot infer a
 * list vector from JS arrays, so the caller builds an explicit `List<Utf8>`
 * vector for a column whose values are arrays (see `readerToArrowTable`).
 */
function toArrowValue(value: unknown): ArrowScalarValue | readonly string[] | null {
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
      if (value instanceof DuckDBListValue || value instanceof DuckDBArrayValue) {
        // Row-diff changed-column lists are VARCHAR[] — every entry renders
        // as text (the engine's reader requires text entries).
        return value.items.map((item) => (item === null || item === undefined ? '' : String(item)))
      }
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

/** The non-null scalar value kinds a converted column can carry. */
type ArrowScalarValue = bigint | number | string | boolean | Uint8Array

/** The non-null value kinds {@link buildColumnVector} builds a scalar vector for. */
type ArrowValue = ArrowScalarValue

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
 * through {@link toArrowValue} and {@link buildColumnVector}. Scalar columns
 * build explicit vectors; a LIST/ARRAY column (m6-3 `assay_changed`) builds
 * an explicit `List<Utf8>` vector, which the engine's `readStringListCell`
 * reads via `toArray()`. The cast at the table boundary is structural:
 * apache-arrow v17's `tableFromArrays` types accept arrays/typed arrays but
 * (unlike its runtime) not `Vector` inputs.
 */
export function readerToArrowTable(reader: DuckDBResultReader): Table {
  const names = reader.columnNames()
  const rows = reader.getRowObjects()
  const columns: Record<string, unknown> = {}
  for (const name of names) {
    const values = rows.map((row) => toArrowValue(row[name] ?? null))
    if (values.some((value) => Array.isArray(value))) {
      columns[name] = vectorFromArray(
        values as readonly (readonly string[])[],
        new List(new Field('item', new Utf8(), true)),
      )
    } else {
      columns[name] = buildColumnVector(values as readonly (ArrowValue | null)[])
    }
  }
  return tableFromArrays(columns as unknown as Record<string, readonly unknown[]>)
}

/** The binding relation the CLI's plans compile against (re-exported). */
export { PLAN_RELATION }
