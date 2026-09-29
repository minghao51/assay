---
'@assay/pipeline': minor
---

feat(p-2): transform compilation to SQL (pure module)

`@assay/pipeline` gains the p-2 compiler: `compilePipeline` turns a validated
`PipelineV1` into deterministic, byte-stable DuckDB SQL — one query per
executable node, in topological order — over relations named by node id and
rendered through `quoteIdentifier` (no generated internal names, no
materialization: p-3 owns execution). The P1 compiled transform vocabulary is
`select-columns` / `rename` / `cast` / `filter`; an unknown transform
operation, and every operation/filter/cast argument-or-value refusal, points
at the documented escape hatch (a `sql` node carrying verbatim SQL with
declared inputs). Verbatim SQL is validated by a pure,
conservative, string/identifier/comment/dollar-quote-aware single-statement
classifier (`classifyVerbatimSql`) that refuses multi-statement text, trailing
garbage, non-read statements, and side-effect/DDL/utility keywords. Filter
predicates are a structured grammar (column + operator + literal(s), including
null tests), never free-form SQL; literals go only through the
`@assay/validation` `sql*Literal` helpers and identifiers only through
`quoteIdentifier`. Compilation is overlay-agnostic, pure, total, and
schema-free.

This also lands the four p-1 carry-over rulings as **pre-version-lock format
tightenings**:

1. node ids prefixed `assay_` (case-insensitive; DuckDB folds identifier case)
   are rejected at parse with a new typed `reserved-identifier` error, because
   node id = relation name and `assay_*` is reserved repo-wide for
   compiler-internal identifiers;
2. **every** number in the IR is now exact-or-rejected at parse (new
   `imprecise-number` error) by reusing `@assay/contracts`'
   `canonicalDecimal` / `isExactDecimalLiteral`, killing the silent
   `9007199254740993` → `…992` rewrite before numbers become SQL-bearing;
3. `diff` (with `validate`/`publish`) stays typed-but-reserved; the compiler
   refuses them with a typed "reserved until P2" error;
4. node id = relation name in deterministic topological order.

`@assay/contracts` re-exports `canonicalDecimal`, `isExactDecimalLiteral`, and
the `CanonicalDecimal` type for the reused numeric policy (exports only; no
behaviour change). Fixtures: `hostile-names.yaml` no longer carries the
reserved node, and a new negative `reserved-namespace-refusal.yaml` pins the
`reserved-identifier` refusal (manifest checksums updated). Unit tests
2317 → 2406 across 156 → 158 files.
