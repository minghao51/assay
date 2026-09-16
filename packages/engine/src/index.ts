/**
 * @assay/engine — the engine interface layer (interfaces only).
 *
 * Every engine implementation (engine-duckdb, engine-parquet, future
 * DataFusion/native engines) passes the same conformance suite
 * (docs/engineering/05-repository-structure.md §4) and stays behind this
 * interface so browser WASM constraints never become product constraints
 * (docs/engineering/03-tech-stack.md §7, ADR 0002/0020).
 */
import type { DataSource } from '@assay/data-sources'

/** Opaque handle to a table registered with an engine. */
export interface TableHandle {
  readonly kind: 'table'
  readonly id: string
}

/**
 * Placeholder stream type. From M1 this becomes Apache Arrow record batches
 * transported from a worker (ADR 0020/0021); the exact Arrow binding is an
 * implementation detail behind this alias.
 */
export type ArrowBatchStream = AsyncIterable<unknown>

export interface QueryRequest {
  sql: string
  limit?: number
  offset?: number
}

/**
 * How the engine classified a column for profiling (m2-5). Classification is
 * per-engine from the engine's own type strings (`profile()` is implemented
 * engine-side); the kinds are the portable contract:
 *
 * - `numeric` — integer/decimal/float columns; carry `numeric` stats.
 * - `categorical` — scalar non-numeric columns (strings, booleans, enums,
 *   dates/times — see below); carry `categorical` top-k.
 * - `other` — nested/exotic types (structs, lists, maps, unions, JSON, blobs,
 *   …) degrade gracefully to name/type/nullCount/distinctCount only —
 *   profiling must never throw on an exotic type (same never-throws contract
 *   as the web type-string parser).
 */
export type ProfileColumnKind = 'numeric' | 'categorical' | 'other'

/**
 * Exact quantiles of a numeric column's non-null values, in double precision
 * (the engine computes them in double arithmetic; `null` when the column has
 * no non-null values). The position set (p50/p90/p95/p99) is the M2 profile
 * contract — m2-6's distribution charts render buckets from these.
 */
export interface NumericQuantiles {
  p50: number | null
  p90: number | null
  p95: number | null
  p99: number | null
}

/**
 * Numeric column statistics (m2-5), each over the column's non-null values,
 * each `null` when undefined on the data (e.g. `stddev` of a single value,
 * `min` of an all-null column). All values are finite JSON numbers: engines
 * must map non-finite results (NaN/±Infinity) to `null` so a profile stays
 * plain JSON-able data across the worker boundary.
 */
export interface NumericColumnStats {
  min: number | null
  max: number | null
  mean: number | null
  /** Sample standard deviation (n−1 denominator); `null` under 2 values. */
  stddev: number | null
  quantiles: NumericQuantiles
}

/** One top-k entry of a categorical column (m2-5). */
export interface CategoricalTopKEntry {
  /**
   * The value in its engine-rendered text form (ADR 0007 spirit: profile
   * outputs are data rendered as text — the engine renders once, deterministically,
   * so the UI never re-implements per-type formatting; NULLs never appear here,
   * `nullCount` carries them).
   */
  value: string
  count: number
}

/**
 * Categorical column statistics (m2-5): the at-most-k most frequent non-null
 * values, ordered by count descending with ties broken by value ascending
 * (deterministic, documented tie behavior). `k` is engine-defined and
 * reported through the array length (engine-duckdb: 10).
 */
export interface CategoricalColumnStats {
  topK: CategoricalTopKEntry[]
}

/**
 * Per-column profile (m2-5): identity, nullability, cardinality — and the
 * kind-specific payload. `numeric` is present iff `kind === 'numeric'`,
 * `categorical` iff `kind === 'categorical'`; `other` columns carry none
 * (graceful degradation, never a throw).
 */
export interface ColumnProfile {
  name: string
  /** The engine's own type string, as `schema()` reports it. */
  type: string
  kind: ProfileColumnKind
  /** Rows whose value is NULL. */
  nullCount: number
  /** Distinct non-null values (NULLs are never counted as a distinct value). */
  distinctCount: number
  numeric?: NumericColumnStats
  categorical?: CategoricalColumnStats
}

export interface DatasetProfile {
  rowCount: number
  columns: ColumnProfile[]
}

export type ExportFormat = 'parquet' | 'jsonl' | 'json' | 'csv' | 'arrow'

export interface ExportOptions {
  compression?: string
  rowGroupSize?: number
  partitionBy?: string[]
}

/** The engine contract (docs/architecture/02-architecture.md §7). */
export interface DataEngine {
  open(source: DataSource): Promise<TableHandle>
  query(request: QueryRequest): Promise<ArrowBatchStream>
  schema(table: TableHandle): Promise<Array<{ name: string; type: string }>>
  profile(table: TableHandle): Promise<DatasetProfile>
  exportTable(
    table: TableHandle,
    format: ExportFormat,
    options?: ExportOptions,
  ): Promise<ReadableStream<Uint8Array>>
}
