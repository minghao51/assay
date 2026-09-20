/**
 * Structural mirrors of the m2 `profile()` shape — `@assay/engine`'s
 * `DatasetProfile` / `ColumnProfile` family, as also mirrored verbatim in
 * the engine-duckdb wire protocol (`EngineProfileColumn` block).
 *
 * Engines are forbidden dependencies for this package (the lint-enforced
 * purity boundary in `eslint.config.js`), so — exactly like
 * `@assay/validation`'s `EngineSchema` precedent — the shape is declared
 * here *structurally* and the engine (or any caller) hands the real thing
 * straight in; TypeScript verifies compatibility at the call site.
 *
 * Field semantics relied on (documented in `@assay/engine`, pinned by the
 * engine conformance suite):
 *
 * - counts are safe non-negative integers; every number is a finite JSON
 *   number or `null` (engines map non-finite results to `null`);
 * - `numeric` is present iff `kind === 'numeric'`, `categorical` iff
 *   `kind === 'categorical'`;
 * - `stddev` is the sample standard deviation (n−1 denominator), `null`
 *   under two non-null values, `0` for a constant column;
 * - quantiles are the exact p50/p90/p95/p99 over non-null values, `null`
 *   when the column has no non-null values;
 * - `topK` is the at-most-k (engine-duckdb: k = 10) most frequent non-null
 *   values, ordered by count descending with ties broken by value
 *   ascending; NULLs never appear (they are `nullCount`).
 *
 * These are *documented expectations*, not trusted guarantees: the model
 * validates all of it and collects typed issues instead
 * (`input-validation.ts`) — the m6-0 totality contract.
 */

/** How the engine classified a column for profiling (m2-5). */
export type ProfileColumnKind = 'numeric' | 'categorical' | 'other'

/** Exact quantiles (p50/p90/p95/p99) of a numeric column's non-null values. */
export interface NumericQuantiles {
  p50: number | null
  p90: number | null
  p95: number | null
  p99: number | null
}

/**
 * Numeric column statistics, each finite-or-null (engines map non-finite
 * results to `null` so a profile stays plain JSON-able data).
 */
export interface NumericColumnStats {
  min: number | null
  max: number | null
  mean: number | null
  /** Sample standard deviation (n−1 denominator); `null` under 2 values. */
  stddev: number | null
  quantiles: NumericQuantiles
}

/** One top-k entry of a categorical column (m2-5): rendered text + exact frequency. */
export interface CategoricalTopKEntry {
  /** The value in its engine-rendered text form; NULLs never appear here. */
  value: string
  count: number
}

/**
 * Categorical column statistics (m2-5): the at-most-k most frequent
 * non-null values, ordered by count descending, ties by value ascending
 * (the documented engine order — the model does not re-sort).
 */
export interface CategoricalColumnStats {
  topK: CategoricalTopKEntry[]
}

/** Per-column profile (m2-5): identity + nullability + cardinality + kind payload. */
export interface ColumnProfile {
  name: string
  /** The engine's own type string, as `schema()` reports it. */
  type: string
  kind: ProfileColumnKind
  /** Rows whose value is NULL. */
  nullCount: number
  /** Distinct non-null values (NULLs are never a distinct value). */
  distinctCount: number
  numeric?: NumericColumnStats
  categorical?: CategoricalColumnStats
}

/** Full profile result: total rows plus one payload per column. */
export interface DatasetProfile {
  rowCount: number
  columns: ColumnProfile[]
}
