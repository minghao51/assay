/**
 * The row-diff plan payload (m6-1) — the compiled, **serializable** form of
 * a key-based row diff between two dataset versions, for the m6-2 engine op.
 *
 * This is the `@assay/validation` m5-1 plan precedent applied to diff: pure
 * SQL text + typed metadata, compiled here, executed later (m6-2 binds side
 * A to the engine's effective view and side B to a staged scratch view).
 * The compiler lives in `row-diff-compile.ts`; this module is the contract
 * the executor binds against.
 *
 * ## Serialization boundary
 *
 * m6-2 ships this object to the engine worker over postMessage: every field
 * is plain JSON-representable data — strings, numbers, arrays of strings.
 * No functions, Maps, or class instances;
 * `JSON.parse(JSON.stringify(plan)) ≡ plan` is pinned.
 *
 * ## The three aspects, exactly (the task row, made structural)
 *
 * Keys are the user-chosen key columns (explicit — an empty key set is a
 * binding error, never an implicit guess; C2 inference proposes, surfaces
 * confirm). Matching is by exact, case-sensitive column name (the m5-1/m6-0
 * policy). With keys `k0…km`, side A = reference, side B = current:
 *
 * - **added** — B rows whose key tuple has no A match (B-keys anti-join,
 *   `NOT EXISTS … IS NOT DISTINCT FROM` per key).
 * - **removed** — A rows whose key tuple has no B match (A-keys anti-join).
 * - **changed** — key-matched pairs where at least one *shared non-key*
 *   column `IS DISTINCT FROM` its counterpart, carrying the per-row
 *   changed-column list. The mechanism is the **full outer join on key**
 *   (`FULL OUTER JOIN … ON key IS NOT DISTINCT FROM key`) with two literal
 *   `TRUE` presence markers, so "matched" is decidable even when key
 *   values are NULL (a NULL-key row's counterpart columns are NULL too,
 *   which would be indistinguishable from an unmatched row without the
 *   markers). Added/removed *columns* are m6-0 schema-drift findings, not
 *   row-diff aspects: only columns present in BOTH schemas are compared,
 *   and keys can never appear in a changed-column list (they are equal by
 *   the join condition).
 *
 * ## NULL keys group together (`IS NOT DISTINCT FROM` semantics)
 *
 * Two NULL keys are **the same key**: an A row and a B row both carrying
 * NULL keys pair as matched — possibly "changed" — never simultaneously
 * added and removed. NULL-key rows are usually key accidents; the report
 * makes them visible instead of guessing. This is the honest v1 semantic
 * and is pinned byte-level in the golden SQL (every join/anti-join
 * condition is `IS NOT DISTINCT FROM`, never `=`).
 *
 * ## Result contracts the SQL is built for (m6-2 pins these)
 *
 * **Per-aspect query (`addedSql` / `removedSql` / `changedSql`)** — at most
 * `sampleLimit` rows; empty result ⇔ the aspect's count is 0 (`sampleLimit
 * ≥ 1` is a binding rule, exactly the m5-1 `LIMIT 0` reasoning):
 *
 *     assay_side        — 'A' | 'B' (see the side-qualified key grammar)
 *     assay_row_ordinal — 0-based position of the row in **its side's
 *                         natural scan order**, computed *before* any
 *                         filtering (the m5-1 `assay_row_ordinal`
 *                         convention, applied per side). Structurally this
 *                         is the m5-1 inner-projection pattern: the
 *                         `row_number() OVER ()` shares its SELECT scope
 *                         with a bare `FROM`, and the anti-join /
 *                         full-outer-join filter is applied *outside* that
 *                         derived table (`assay_antijoin_source` / `ai`) —
 *                         SQL evaluates windows after `WHERE`, so a
 *                         same-SELECT filter would number only the
 *                         survivors `0..K-1` (the m6-1 round-1 defect).
 *                         For `changed` this is the **A-side** row of the
 *                         pair (A-side rows must stay grid-resolvable;
 *                         the B counterpart is report content, C3) and is
 *                         carried out by the outer projection as
 *                         `"ai"."assay_row_ordinal"`.
 *     assay_changed     — `changed` only: the LIST(VARCHAR) of shared
 *                         non-key columns that differ on this pair, in
 *                         shared-column order (schema-A order).
 *     sample_index      — 0-based ordinal of this sample row within the
 *                         aspect's result set.
 *     assay_count       — the aspect's **exact** count over the FULL
 *                         relations (window-evaluated before `LIMIT`),
 *                         repeated on every row — the m5-1 `fail_count`
 *                         convention, so per-aspect ≡ totals agreement is
 *                         structurally checkable in m6-2/m6-5.
 *
 * Sample selection takes the **first K rows in natural scan order**
 * (`LIMIT`, no `ORDER BY`) — the documented m5-1/m5-2 engine-determinism
 * contract; m6-2 may clamp K further engine-side.
 *
 * **Totals query (`totalsSql`)** — exactly one row per aspect, in aspect
 * order (`UNION ALL` of three arms; no `ORDER BY` — arm order is
 * canonical), derived from the *same* source fragments as the per-aspect
 * queries (shared builders in `row-diff-compile.ts`, so per-aspect and
 * totals counts cannot diverge):
 *
 *     assay_aspect — 'added' | 'removed' | 'changed'
 *     assay_count  — the exact count (must equal the per-aspect query's)
 *
 * All counts are integral; the plan carries **integers only** (counts, K,
 * ordinals) — report rounding (`roundForReport`) has nothing to round
 * here, which is itself the m6-5 byte-agreement guarantee for row-diff
 * numbers.
 *
 * ## Side-qualified row keys — the grammar and the m6-2 binding contract
 *
 * Every sample row identifies its row as the pair
 * `(assay_side, assay_row_ordinal)`:
 *
 * - **A-side (`assay_side = 'A'`)** rows resolve in the grid per the
 *   m4-1/m4-3 logical `RowId` grammar: the host combines its own base
 *   anchor token (host-supplied, *never known to this package or to the
 *   plan*) with the sample's ordinal as `base:<anchor>#<ordinal>`. This
 *   works because the engine's composed effective relation orders by
 *   `assay_key` (the m4-2 contract), so the natural scan order this plan
 *   ordinals **is** the engine's effective row list order — when side A is
 *   the effective view, `assay_row_ordinal` is the index into the domain's
 *   `effectiveRowIds`. m6-2 must bind A to that view (or document the
 *   base-view case, where the same grammar holds for the base scan order).
 * - **B-side (`assay_side = 'B'`)** rows are **report content only**
 *   (checkpoint C3): the staged scratch view has no grid anchor, so their
 *   documented report-side key form is `b:<ordinal>` — deliberately
 *   non-grid-resolvable, never fed to the m4-3 grammar.
 *
 * ## Identifier invariants (why any legal dataset column name binds)
 *
 * Exactly the m5-1 structural policy, extended to two relations. The plan's
 * SQL reserves two namespaces for itself — the `assay_*` spellings
 * (`assay_side`, `assay_row_ordinal`, `assay_changed`, `assay_count`,
 * `assay_aspect`, `assay_key_<i>`, `assay_col_<j>`, `assay_present_a`,
 * `assay_present_b`, plus the m5-1-style result column `sample_index`) and
 * the two range names — and is *shaped* so no dataset name can ever meet a
 * reserved name at one scope:
 *
 * - the side-A relation is always `FROM "RA" AS "a"`, side B
 *   `FROM "RB" AS "b"` (documented range names; the only two top-level
 *   ranges in the dialect of this plan), the anti-join sources are the
 *   reserved `"assay_antijoin_source"` derived tables, and the changed
 *   aspect's two inner derived tables are `"ai"`/`"bi"` (per-side
 *   projections inside the full outer join);
 * - every source-column reference is **range-qualified**
 *   (`"a"."col"` / `"b"."col"` — a qualified reference resolves only
 *   against the FROM range, never against an alias elsewhere);
 * - every derived table exposes **only reserved aliases** (source columns
 *   cross a scope boundary only renamed: keys as `assay_key_<i>`, shared
 *   columns as `assay_col_<j>`, ordinals as `assay_row_ordinal`).
 *
 * A dataset column may therefore be named anything — including `a`, `b`,
 * `assay_row_ordinal` in any casing, or SQL keywords — and stays bindable
 * and correctly executable (m5-1 proved the class against real DuckDB;
 * the goldens here pin the hostile-name shapes textually, and m6-2
 * executes them).
 *
 * ## Injection hardening
 *
 * There are **no dataset values in a row-diff plan** — only names and
 * integers. Identifiers enter SQL exclusively through
 * `quoteIdentifier`; the only literals are integers (`sampleLimit`, via
 * `sqlIntegerLiteral`), column *names* rendered as string literals for the
 * changed-column lists (`sqlStringLiteral`), and fixed internal constants
 * (`'A'`, `'B'`, `'added'`, `'removed'`, `'changed'`). NUL-carrying names
 * are rejected as typed binding errors *before* any helper runs (the
 * `@assay/validation` literals contract). Both invariants are pinned
 * structurally by scan-style tests over every generated query.
 */

/** Discriminator carried by the plan (defensive versioning at the wire). */
export const DIFF_PLAN_KIND = 'assay-row-diff-plan' as const

/** The only plan version this compiler emits. */
export const DIFF_PLAN_VERSION = 1 as const

/** The row-diff aspects, in the documented plan order (the task row's order). */
export type RowDiffAspect = 'added' | 'removed' | 'changed'

/** Documented aspect order for totals arms and any consumer rendering. */
export const ROW_DIFF_ASPECTS: readonly RowDiffAspect[] = ['added', 'removed', 'changed']

/**
 * A compiled row-diff plan (see module doc for the full contract).
 * Plain, JSON-stable data; byte-identical for identical inputs.
 */
export interface RowDiffPlan {
  readonly planKind: typeof DIFF_PLAN_KIND
  readonly planVersion: typeof DIFF_PLAN_VERSION
  /** Side-A (reference) relation name, as given in the compile options. */
  readonly relationA: string
  /** Side-B (current) relation name, as given in the compile options. */
  readonly relationB: string
  /** The explicit key columns, in the caller's given order (deduplicated spellings are a binding error, never silently collapsed). */
  readonly keys: readonly string[]
  /** The K of the sample bound (≥ 1). Exact counts travel with every query regardless of K. */
  readonly sampleLimit: number
  /**
   * Columns present in BOTH schemas (exact, case-sensitive match), in
   * schema-A order — the changed-column list order. Keys are excluded
   * (they cannot differ on a matched pair).
   */
  readonly sharedColumns: readonly string[]
  /** Added samples: B keys with no A match (see module doc). */
  readonly addedSql: string
  /** Removed samples: A keys with no B match (see module doc). */
  readonly removedSql: string
  /** Changed samples: matched pairs with ≥ 1 distinct shared column (see module doc). */
  readonly changedSql: string
  /** One row per aspect in aspect order; counts must equal the per-aspect queries'. */
  readonly totalsSql: string
}
