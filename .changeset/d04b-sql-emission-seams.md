---
'@assay/engine-duckdb': patch
---

refactor(d04b): extract the COPY/export SQL emission group (and pin shared
SQL-constant ownership) inside `@assay/engine-duckdb`.

New engine-local module `export-query.ts` owns the export emission group that
used to live at the tail of the 1,930-line `overlay-query.ts`: the pinned
per-format COPY option table, `PARQUET_COPY_OPTIONS`, `exportFileExtension`,
`composeOverlayExportSql` and `composeOverlayExportSelectSql`, plus the CSV
header-guard policy that only the export SELECT uses. Every export there is a
pure function of `(composition, format, destination)` — no engine handle, no
session, no module-level mutable state. `overlay-query.ts` stays the owner of
the overlay composition and exposes exactly two seams the export group composes
over (`composeEffectiveSourceSql`, `assertRepairExportBudget`) instead of
re-deriving the effective relation.

Shared SQL fragments now have one canonical owner each:

- `PARQUET_COPY_OPTIONS` is the single owner of the pinned parquet fragment —
  the `parquet` format entry and the pipeline export node
  (`engine-executor.ts`, which re-typed the same string inline) both reference
  it;
- `OVERLAY_ORDINAL_COLUMN` is the single owner of `assay_overlay_ord` — the
  reserved-name set and `validate-query.ts`'s baked index column derive from it;
- `quotedRelationToken` in `validate-plan-wire.ts` / `diff-plan-wire.ts`
  delegates to `format-view.ts`'s `quotedIdentifier` instead of re-implementing
  identifier quoting.

**No SQL or semantics change** — this is seams only: the composed COPY
statement, the pinned option tokens, the alias hygiene (quoted identifiers,
CSV header guard), row ordinals, repair masking, the set-membership predicate
shape (ADR 0051) and every cap/limit are byte-identical, and the export
budget/refusal behavior is untouched. Existing compiler/golden SQL snapshots
and the native-DuckDB agreement suites pass with **no expectation changes**
(only import paths moved); no public specifier was added or removed — `index.ts`
re-exports the same names from the new module. No dependency, cap, memory or
retained-table change; no new publication globs (the existing explicit `dist/*`
globs already cover the new emitted JS/declarations/maps, verified by packing
and the pack-consumer smoke).

Invariants re-verified by mutation (worktree mutants, each reverted): altering
the COPY option token (`ROW_GROUP_SIZE 122881`) fails the parquet COPY golden;
altering the CSV header-alias quoting fails the header-guard pins; renaming the
canonical ordinal constant fails the window/count/schema goldens; dropping the
double-quote doubling in `quotedRelationToken` fails the compiler-quoting pin.
