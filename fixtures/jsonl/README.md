# JSONL fixtures

## `nested.jsonl` (m3-1)

Hand-authored, deterministic, obviously synthetic NDJSON — 12 rows covering
every nested shape the M3 milestone exercises downstream (cell preview m3-2,
inspector m3-3, flatten/explode/path m3-4/5):

- **struct-of-struct, depth 3** — `deep.a.b.c`, including a NULL leaf
  (`deep.a.b.c = null`, row id 7) and two whole-NULL structs (ids 4, 11)
- **list-of-scalars** — `tags`, including the empty list (ids 2, 9) and a
  NULL list (ids 4, 10)
- **list-of-structs, ≥ 2 elements with mixed NULL fields inside** — `events`
  (NULL `at` and/or NULL `ok` inside elements: ids 2, 3, 6, 7, 12), plus NULL
  *elements* (ids 4, 11) and a whole-NULL list (id 10)
- **mixed NULLs** — NULL struct field (id 7), NULL list element
  (`tags = ["x", null, "z"]`, id 3), and an all-NULL column (`hole`, every row)
- **unicode + escapes** — embedded double/single quotes, backslashes, `\t`
  and `\n` escapes, CJK/Latin/Cyrillic text and emoji in `label`
- **scalar context columns** — `id`, `kind`, `label`, `score` (with NULLs),
  so flatten keeps non-nested context

### Quoting-hostile key (m3-4 injection surface)

Every row carries the object key **`weird "quoted" key`** (embedded double
quotes; value = that row's `id`). When this column reaches SQL it must be
treated as an identifier — double-quote-escaped by the composer — never
spliced into a statement as raw text. It is deliberately present on *every*
row so the JSON sniffer sees a stable column type (`BIGINT`) instead of a
partial-row schema union.

JSONL cannot carry comments (every line must be a JSON value), so this README
is the fixture's header documentation. The exact expected bytes/shape are
pinned by the engine conformance suite (m3-1 scenarios in
`@assay/testing`; expectations live in the engine-duckdb harness subject and
`tests/e2e/engine-conformance.spec.ts`).

Provenance: committed text, hand-authored; **not** listed in
`parquet/manifest.json` (that manifest covers generated Parquet fixtures
only). A byte-identical copy is served to the browser harness at
`packages/engine-duckdb/harness/public/fixtures/nested.jsonl`.
