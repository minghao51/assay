# WF-O2 type-propagation contract (R-5) — declared types into nested previews, the Record tree and SQL results

**Date:** 2026-11-23. **Status:** DRAFT — awaiting maintainer approval. **This document authorises no
runtime work.** It is the contract the [H1 UX runtime briefs](20261122-h1-ux-runtime-briefs.md) §R-5
requires before any runtime row is reserved, commissioned by the
[WFD selections](20261123-wfd-selections.md) §5 (contract **and** probes; item 3 gated on
measurement). Its item-3 evidence is the sibling
[real-engine probe record](20261123-wfo2-type-propagation-probe.md).

## 1. Scope, authority, and what this contract is not

The brief's five itemised decisions are answered here in the order it lists them: §3 child-type
ownership, §4 Record-tree schema and hostile input, §5 SQL result metadata (the **probed** answer
only), §6 assertion disposition, §7 fixture/performance matrix. §8 states what is decided and what is
still undecided rather than guessing; §9 states the approval gate.

What the contract **is**: the specification the runtime dispatch (brief items 3–6) must implement
without improvising, plus the honest limit where parity is not achievable.

What the contract **is not**: authorisation to edit any file under `apps/`, `packages/`, `tests/` or
`fixtures/`; a claim that "all temporal displays are fixed"; a reopening of WFD-06 = B, of the scalar
scope, of the filter-draft work (`030aa87`) or of any E04 §2/§3 surface.

## 2. Constraints carried in — not reopened here

| Constraint (source)                                                                                                                                                           | Consequence for this contract                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **WFD-06 = B stands** — UTC ISO-like text at the exactly delivered precision, raw fallback otherwise, `TIMESTAMP_NS` always raw (`apps/web/src/grid/temporal-display.ts:114`) | Every surface reuses `formatTemporalForParsedType`/`formatCell`'s rules. No new scalar rule, no editor-seed change, no tolerance widening. |
| Nested preview invariants: total / deterministic / length cap 120 / depth cap 3 / distinct NULL-empty (`apps/web/src/grid/nested-preview.ts:3-41`)                            | Type decoding is an inner leaf transform only; caps, ordering and markers are untouched.                                                   |
| Record tree invariants: total, `(circular)`/`(unreadable)` markers, deterministic own-key order, AR-W8 child cap (`apps/web/src/record/record-tree.ts:3-35`)                  | Type decoding never adds a throwing path and never changes tree shape or markers.                                                          |
| Fail soft on any payload/type mismatch (E04 §4)                                                                                                                               | A decoder returning `null` leaves the existing raw/summary render. Absence is normal, not an error.                                        |
| Copy parity goal (E04 §4) — one value renders identically in grid cell, nested preview, Record tree and SQL result                                                            | Parity is of the **display text**; a container's own framing (quoting) is not part of it. See §4.5.                                        |
| Non-goals: export/edit/filter raw fidelity unchanged; **no Arrow→rows projection change**; **no engine/wire change**                                                          | `projectBatchToRows` (`apps/web/src/grid/provider.ts:270`) and every engine op stay byte-identical.                                        |
| Today's state is deliberate, not a bug to sweep (brief)                                                                                                                       | Nothing here declares the current rendering wrong; it declares what would change if approved.                                              |

## 3. Item 1 — declared child-type ownership

### 3.1 Who owns the type of a nested child

**The declared result field's type owns it, and nothing else.** For a cell at column position `i`,
the authority is the Arrow field's type as delivered:

- **Grid / Record tree:** the effective schema's declared column type string, parsed once per column
  by `parseDuckDbType` (`apps/web/src/schema/parseType.ts`), threaded today as
  `NestedPreviewOptions.columnType` (`nested-preview.ts:79`) and `RecordRowInput.columnTypes`
  (`record-tree.ts:62`).
- **SQL result:** the Arrow field's own type, mapped to the app's DuckDB-label vocabulary (§5.3) —
  never the base table's schema.

A container's children are owned by the type node that declares them:

| Container      | Child position     | Declared type carrier (probed, present at every depth)     | Today's app path                                      |
| -------------- | ------------------ | ---------------------------------------------------------- | ----------------------------------------------------- |
| `STRUCT`       | named field        | `Struct<{name: T}>` — named children                       | `fieldType()` (`nested-preview.ts:206`) — works       |
| `UNION`        | named member (tag) | `Union<T…>` — children keep member names (probe A case 12) | `fieldType()` — works                                 |
| `LIST`/`ARRAY` | element            | `List<T>` / `FixedSizeList<T>`                             | `listElementType()` (`nested-preview.ts:194`) — works |
| `MAP`          | value (and key)    | `Map<{key:K, value:T}>` (probe A case 8)                   | **none** — `fieldType()` returns `null` for `map`     |
| anything else  | —                  | unknown kind ⇒ no child type                               | `null` — raw/summary path                             |

### 3.2 The MAP rule (the one real gap in the current plumbing)

`parseDuckDbType` **already models** `MAP(K, V)` (`parseType.ts:49`, `:232-237`); only `fieldType`
declines it. A delivered `MapRow`'s own keys are **data** (map keys), not schema field names, so
`fieldType(type, key)` can never resolve them and must not be stretched to try.

The contract therefore fixes the rule as: **a map child's type is the declared value type `V`,
applied to every own value; the declared key type `K` applies to the keys, which are rendered as
keys and never as typed leaves.** A `MAP` whose value type is not modelled (unknown leaf) keeps the
type-blind render. This is the only place where the child type is positional-by-kind rather than
named-by-field, and it must be stated in the code comment that implements it.

### 3.3 When the type is absent or unknown

Absent (`null`, a short `columnTypes` array, an `unknown` parsed kind, a container whose Arrow type
is unmapped) means **"no declared type"** and the existing behaviour is unchanged: struct/list
children render exactly as today. There is no inference path. Specifically, a decoder may **not**:

- infer a type from a sibling child, from the payload's shape, its byte width, or its string form;
- infer a type from the base table when the result is a SQL query (§5.4);
- treat `<N bytes>` or a raw number as a hint;
- re-parse a value's text to recover a type it was not told.

If a declared type arrives but the payload contradicts it (width mismatch, wrong shape, unreadable),
the answer is `null` from the decoder and the existing summary — the fail-soft rule, already pinned
for decimals at `nested-preview.test.ts:482-489` and for `UHUGEINT` at `:482`.

### 3.4 Which leaves decode

Under the scalar rules only, i.e. the decoders the grid already uses, applied at the nested
position: `DECIMAL`/`NUMERIC`/`HUGEINT` (`grid/decimal.ts`), `UHUGEINT` (`grid/uhugeint.ts`) and the
temporal families `DATE`, `TIMESTAMP*` except `TIMESTAMP_NS`, `TIME`/`TIMETZ`
(`grid/temporal-display.ts`). **`TIMESTAMP_NS` is not decoded anywhere**, nested or otherwise: its
declared precision cannot survive the Arrow→rows projection, so it keeps the raw payload on every
surface. Everything else (BLOB, ENUM, INTERVAL, unmapped types) keeps its existing render.

## 4. Item 2 — Record tree: schema vs hostile input

### 4.1 What the tree is given

`buildRecordTree({ columns, cells, columnTypes })` (`record-tree.ts:296`). The caller supplies the
schema: `RecordInspector` passes `columns` from the effective schema and `columnTypes` as
`schema.map((column) => parseDuckDbType(column.type))` (`RecordInspector.tsx:544-552`, `:648-652`,
`:695-699`). The cells are the hostile-suspect half: they arrive positionally from the Arrow→rows
projection, may be shorter than `columns`, may contain cycles, throwing getters, proxies or payloads
that contradict their declared type.

### 4.2 Ownership split (the rule to preserve)

**Schema in, values out.** The tree never derives a type from a value and never lets a value change
the tree's shape. Node kinds, keys, child order, `elidedChildren` counts and the
`(circular)`/`(unreadable)` markers come from `columns` + the values' own delivered order — the
declared types are _hints for leaf summaries only_.

### 4.3 The fail-soft / full-totality rule

- A missing entry (`columnTypes` shorter than `columns`, an explicit `null` element), an `unknown`
  parsed kind, or a `null` decoder result ⇒ the current summary, unchanged.
- Type decoding happens **inside** the existing `formatNestedPreview` summary call and nowhere else.
  The tree keeps no second decoder, so a hostile payload costs exactly what it costs today.
- No new throw, no new marker, no new placeholder: a decoder that cannot read exactly returns
  `null`; a hostile container still yields `(circular)`/`(unreadable)` leaves.
- Determinism is preserved: the same `(columns, cells, columnTypes)` triple builds the same tree.

### 4.4 What "full-depth" adds and does not add

Full-depth traversal already exists (children beyond the preview's depth cap become nodes). The
contract adds only: each node's summary decodes its leaf under the declared type when one is known at
that position — the same summary path the preview uses, so parity is inherited rather than forked
(the module already imports `formatNestedPreview`, `record-tree.ts:37-40`).

### 4.5 Parity is text parity, and quoting is framing (decided here, overridable)

The Record tree's summaries already render a string leaf **quoted** (`'"y"'`,
`record-tree.test.ts:93`; `'"ok"'`, `:233`; the defensive `Date` leaf `'"2025-03-01T10:00:00.000Z"'`,
`:157`). A decoded temporal leaf's display text is **text**, so inside a container it renders as a
JSON string literal, exactly like every other string leaf, and identically at the tree root and in a
nested preview. The scalar grid cell and the display-copy show the same text **unquoted** (they are
not JSON).

Therefore parity means: **the bytes inside the value are identical on all four surfaces**; the
preview/tree add their own container framing. Nothing in this contract authorises changing the
grid-cell or copy text to match a quoted form (that would reopen WFD-06 = B's scope). The rejected
alternative — rendering a temporal leaf bare inside a container — is refused because it would make a
text value visually indistinguishable from a number and would contradict the existing string-leaf
convention.

## 5. Item 3 — SQL result metadata: the probed answer only

### 5.1 Verdict

**Present, and type-informative.** Every probed result field carries a real Arrow field **type**,
including computed expressions, unnamed function results, aliases that rename a base column, aliases
over expressions, and children of structs/lists/maps/unions — and it survives the pane's exact wire
path (`tableToIPC` in the worker → `tableFromIPC` in the client).

The decisive observation (probe record §3): `SELECT t + INTERVAL 1 DAY AS shifted FROM probe` yields
field `shifted` of type `Timestamp<MICROSECOND>`, arrowTypeId 10 — **the same field type a plain `t`
column yields** — and still `Timestamp<MICROSECOND>` after the wire round-trip. Computed and aliased
columns are indistinguishable from base columns at the schema level.

It is the field **type**, not custom metadata: `field.metadata` and `table.schema.metadata` are the
empty map in every probed case.

### 5.2 What that means for this item

The parity goal for typed SQL results **is achievable** without an engine or wire change, because the
channel already arrives. It is populated from the Arrow field the pane already holds; it is not
looked up, not re-queried, and not guessed.

### 5.3 How the channel would be populated (specification, not implemented here)

1. `QueryBatchLike` (`paged-query.ts:93-96`) gains a structural `type` on its field slice — the real
   `apache-arrow` `Table` already satisfies it, so this is a type-level widening with **no wire
   change and no projection change**.
2. A pure `resultColumnTypes(batch)` sits beside `resultColumnNames(batch)` (`:103`), returning one
   `DuckDbType | null` per position, total (a missing field ⇒ `null`, never a throw), and callers
   keep passing per-field types down to `formatCell` at `SqlPanel.tsx:400`.
3. The mapping is Arrow-type → DuckDB **label**, then the existing `parseDuckDbType`. The measured
   crosswalk (probe record §5) is the authority:

| Arrow field type (measured)                                                            | DuckDB declared label (measured)             | Mapped label the app may use                  |
| -------------------------------------------------------------------------------------- | -------------------------------------------- | --------------------------------------------- |
| `Date32<DAY>`                                                                          | `DATE`                                       | `DATE`                                        |
| `Timestamp<MICROSECOND>`                                                               | `TIMESTAMP`                                  | `TIMESTAMP`                                   |
| `Timestamp<SECOND>`                                                                    | `TIMESTAMP_S`                                | `TIMESTAMP_S`                                 |
| `Timestamp<MILLISECOND>`                                                               | `TIMESTAMP_MS`                               | `TIMESTAMP_MS`                                |
| `Timestamp<NANOSECOND>`                                                                | `TIMESTAMP_NS`                               | `TIMESTAMP_NS` (⇒ raw)                        |
| `Timestamp<MICROSECOND, UTC>`                                                          | `TIMESTAMP WITH TIME ZONE`                   | `TIMESTAMP WITH TIME ZONE`                    |
| `Time64<MICROSECOND>`                                                                  | `TIME` **or** `TIME WITH TIME ZONE`          | `TIME` (same display family; see below)       |
| `Decimal[p, s]`                                                                        | `DECIMAL(p,s)`; `HUGEINT` is `Decimal[38e0]` | `DECIMAL(p,s)`                                |
| `FixedSizeBinary[16]`                                                                  | `UHUGEINT`                                   | `UHUGEINT`, or `null` if ever ambiguous       |
| `Struct<{…}>`, `List<T>`, `Map<{k,v}>`, `Union<…>`                                     | the same shape                               | the same shape, recursively                   |
| anything unmapped (e.g. `Interval<MONTH_DAY_NANO>`, `Binary`, `Utf8`, `Int64`, `Bool`) | non-temporal here                            | `null` — raw, which is what they render today |

Two measured Arrow-side losses must be stated, not worked around: `TIME WITH TIME ZONE` is
indistinguishable from `TIME` at the Arrow schema level (both `Time64<MICROSECOND>`, bigint µs
payload) — harmless here because both are the `time` display family — and `UUID` arrives as `Utf8`.
An unmapped or ambiguous type maps to `null`; it never maps to a plausible guess.

### 5.4 What the channel may not do

- **Never** read a type from the base table (by column name, by ordinal, by `SELECT *` shape). A
  query is arbitrary SQL: `SELECT t AS renamed`, `SELECT t + INTERVAL 1 DAY`, and a shadowing alias
  make name- and position-based guessing wrong; the effect's own field type is the only authority.
- **Never** re-query (`DESCRIBE`, `typeof(...)`, a second execution) to recover a type.
- **Never** change the wire: no new engine op, no extra field on the existing response, no change to
  `batchIpc`, `hasMore` or `projectBatchToRows`. The type travels inside the Arrow IPC payload that
  is already sent.
- **Never** map an unknown Arrow type to a "close enough" label, and never re-derive a label from the
  payload's bytes.
- **Never** relax `TIMESTAMP_NS` to raw-or-formatted on the strength of a float payload.

### 5.5 The honest limits (recorded, not designed around)

1. **`TIMESTAMP_NS` stays raw on every surface**, including SQL results, because its declared
   precision is destroyed by the Arrow→rows projection before any formatter runs.
2. **Unmapped Arrow types stay raw** (INTERVAL, BLOB, ENUM, `Variant`, and whatever a future engine
   adds). The channel is a decoder for the families in §3.4, not a formatter sweep.
3. **A computed expression's declared type is the delivering engine's inference**, and it can change
   with the engine: `date_trunc('day', <TIMESTAMP>)` is declared `DATE` by the shipped wasm engine
   (DuckDB v1.4.3) and `TIMESTAMP` by the pinned v1.5.5 engine (probe record §6). A parity claim is
   therefore always "identical to the scalar cell rendered from the same declared type" — never "this
   expression always renders `YYYY-MM-DD`".
4. **`Time64`/`Utf8` labels cannot be reconstructed** (§5.3). Reading a display family is supported;
   claiming the exact DuckDB label is not.

## 6. Item 4 — assertion disposition

Dispositions apply to a **future approved runtime dispatch**; nothing is edited now. "KEEP" = the
assertion's meaning is unchanged and it must stay green **unmodified**.

### 6.1 Assertions that change meaning (retargeted, with replacements)

| #   | Assertion                                                                                                                                         | Why it changes                                                                                                                                               | Disposition and replacement                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `tests/e2e/nested-grid.spec.ts:54` — `events` preview `'[{"at":1740823200000,"ok":true},…]'`                                                      | `fixtures/jsonl/nested.jsonl` declares `events STRUCT("at" TIMESTAMP, ok BOOLEAN)[]` (CLI-verified), so the child type is known and `at` decodes.            | **RETARGET**: expected strings become the quoted display text (`"at":"2025-03-01T10:00:00Z"`). The **raw** pin for a type-known leaf moves to `ts_ns` (§6.2 row 5) and to the unit-level no-type pin (§6.2 row 1).                                                                                                                                                                                                                                    |
| 2   | `tests/e2e/record-inspector.spec.ts:119-126` — `events.0.at` = `'1740823200000'`                                                                  | Same declared type; the tree summary inherits the preview's decode.                                                                                          | **RETARGET** to the same quoted display text; `ok`/`meta`/`hole` expectations stay byte-identical.                                                                                                                                                                                                                                                                                                                                                    |
| 3   | `tests/e2e/temporal-display.spec.ts:194-260` — `record` `toContainText('1709214312123.456')` + `not.toContainText('2024-02-29T13:45:12.123456Z')` | The Record tree gains the declared-type channel, so the `ts` column summary becomes the display text and both halves invert.                                 | **RETARGET the instrument, keep the proof**: the "display never entered storage" claim is re-pinned on (a) the `ts_ns` column, which must still show `1709214312123.4568` **by rule**, and (b) the unchanged inline-editor draft `toHaveValue('2024-02-29T13:45:12.123Z')`, which proves the formatted string is not what the editor seeds. The positive `ts` containment is deleted **only** with those two replacements present in the same change. |
| 4   | `apps/web/src/record/record-tree.test.ts:139` title "…(m3-1 worker-boundary contract)"                                                            | The assertion passes **no** `columnTypes`, so it still means "no declared type ⇒ raw" — but its title would then claim the opposite of the shipped contract. | **KEEP the assertion, RETARGET the title** to "renders epoch-ms timestamps as plain numbers **when no declared type is given**".                                                                                                                                                                                                                                                                                                                      |

### 6.2 Assertions explicitly retained

| #   | Assertion                                                                                   | Why it stays                                                                             |
| --- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1   | `apps/web/src/grid/nested-preview.test.ts:57-63` (no `columnType`)                          | The type-blind path stays a first-class contract; it is the fail-soft/absence pin.       |
| 2   | `apps/web/src/grid/nested-preview.test.ts:446-560` (m4-5 decimals, `UHUGEINT`, `<N bytes>`) | Decimal decoding semantics are unchanged; the temporal channel is additive.              |
| 3   | `apps/web/src/grid/format.test.ts:24-38` (typed scalar pins incl. `TIMESTAMP_NS` raw)       | Scalar scope and WFD-06 = B are unchanged.                                               |
| 4   | `apps/web/src/grid/format.test.ts:99-118`, `nested-preview.test.ts` caps/hostile cases      | Total/deterministic/capped/distinct-NULL invariants are unchanged.                       |
| 5   | `tests/e2e/temporal-display.spec.ts` `ts_ns` raw-number test (`:129`)                       | `TIMESTAMP_NS` stays raw by rule, on every surface — this becomes the primary raw proof. |
| 6   | `apps/web/src/grid/copy-cell.test.ts:62-78` (display-copy byte-identity)                    | Copy composes through `formatCell`; scope and text unchanged.                            |
| 7   | `apps/web/src/sql/paged-query.test.ts` (`resultColumnNames`, page composition)              | Names stay names; `resultColumnTypes` is additive.                                       |
| 8   | Export/edit/filter raw-fidelity pins (engine export boundary, filter/editor suites)         | No raw transport change; explicitly out of scope.                                        |

### 6.3 Assertions to delete

**None.** Every changed assertion above has a named replacement in the same change. If a runtime
dispatch cannot keep the raw-fidelity proof somewhere (§6.1 row 3), it must stop rather than delete
the proof — that is a stop rule, not a judgement call.

### 6.4 New assertions the dispatch must add

Cross-surface parity (one value, four surfaces: grid cell, nested preview, Record tree, SQL result);
nested struct/list **and** map temporal + decimal leaves; a `MAP` whose value type is temporal; SQL
alias / computed expression / unnamed function / paged-wrap metadata; an unmapped Arrow type ⇒ raw;
nested `TIMESTAMP_NS` ⇒ raw; hostile containers still total with markers intact; and the brief's
mutation drill (drop the declared-type channel in one leaf branch → a parity assertion fails; restore
byte-identically).

## 7. Item 5 — fixture and performance matrix

### 7.1 Committed fixtures and what they already exercise

| Fixture (committed)                          | Declared nested/typed shapes (CLI-verified)                                                                     | Cases it serves                                                                              |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `fixtures/parquet/temporal.parquet`          | `d DATE`, `ts TIMESTAMP`, `ts_ns TIMESTAMP_NS`, `t TIME`; 4 rows incl. pre-1970, sub-ms and NULL                | SQL result parity per family; Record-tree root leaves; `TIMESTAMP_NS` always raw; NULL cells |
| `fixtures/parquet/temporal-infinity.parquet` | `ts TIMESTAMP`, `ts_ns TIMESTAMP_NS`, `label`; out-of-range instants                                            | Infinity/overflow raw fallback (unchanged)                                                   |
| `fixtures/parquet/nested.parquet`            | `payload STRUCT(name, geo STRUCT(lat DECIMAL(21,1), lon DECIMAL(21,1)), tags VARCHAR[], scores STRUCT(q1, q2))` | Nested decimal leaves (existing); struct-of-struct depth cap                                 |
| `fixtures/parquet/llm.parquet`               | `messages STRUCT(role, content, tool_calls STRUCT(name, args STRUCT(city))[])[]`, `eval STRUCT`                 | Deep list-of-struct nesting under the caps; no temporals                                     |
| `fixtures/jsonl/nested.jsonl`                | `events STRUCT("at" TIMESTAMP, ok BOOLEAN)[]`, `deep`, `meta`, `tags`, all-NULL `hole`                          | **The only committed nested temporal child type** — the e2e parity driver for §6.1 rows 1–2  |
| `fixtures/parquet/wide.parquet`              | `id BIGINT`, `label`, `bucket BIGINT`, `value_maybe_null DECIMAL(21,1)`; 10 × 100 rows                          | Width/perf baseline; no temporals                                                            |

### 7.2 The fixture this contract reserves (not generated here)

**`fixtures/parquet/nested-temporal.parquet`** — name reserved by this contract, to be generated by
`fixtures/parquet/generate.sh` with its checksum recorded in `fixtures/parquet/manifest.json` (ADR
0038; never hand-edited). Required columns, one row each plus a NULL-container row:

1. `s STRUCT(t TIMESTAMP, ns TIMESTAMP_NS, tm TIME, d DATE, dec DECIMAL(10,2))` — the four scalar
   families and a decimal **inside a struct**;
2. `l STRUCT(…)[]` — the same field types as list-of-struct elements;
3. `m MAP(VARCHAR, TIMESTAMP)` — the §3.2 map rule;
4. `u UNION(a DATE, b TIMESTAMP)` — member-owned child types (note the engine narrows a union value to
   its live member, probe record §5);
5. `nulls STRUCT(t TIMESTAMP, arr TIMESTAMP[])` with a NULL container and a NULL child, so "absent
   type" and "NULL value" stay distinguishable.

No fixture may be added that contains real or sensitive data (AGENTS.md fixtures rule).

### 7.3 Synthetic shapes (in-test, no fixture)

Hostile payloads that must stay total: cycles, throwing getters, proxies, a declared-temporal column
delivering a string/`Uint8Array`/`Date`, a wrong-width decimal at a declared decimal position, a
`MAP` with an unmodelled value type, an empty `{}`/`[]` at a declared container position, and the
120-char/depth-3 caps applied to a type-decodable container.

### 7.4 Performance: what may be claimed now, and what must be measured then

**No performance number is claimed by this contract, and none was measured.** What the contract
requires instead:

- The render cost stays **bounded by shape, not size** (length cap 120, depth cap 3) — the existing
  invariant, re-proved by the existing property tests, not by a new claim.
- No new per-cell type parsing: callers pass the already-parsed `DuckDbType` (grid precomputes one per
  column; the SQL pane parses once per result field, not per cell).
- At runtime dispatch, measure and record: a 120-char preview over a depth-3 hostile container before
  vs after, and one SQL page (50 rows × N fields) before vs after. **The thresholds are undecided**
  (§8) — they are set against the measured baseline in that dispatch, not guessed here.

### 7.5 Where the matrix lives

This table is the matrix of record. A runtime dispatch extends the brief's named test files
(`format.test.ts`, `nested-preview.test.ts`, `record-tree.test.ts`, `paged-query.test.ts` plus
`tests/e2e/{nested-grid,nested-decimal,record-inspector,sql-editor,temporal-display}.spec.ts`) and
adds §7.2's fixture; it does not restate the matrix in a second place.

## 8. Decided vs undecided

| Item                                  | State                                           | Why                                                                                                                                                                                                                                                                                  |
| ------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Child-type ownership               | **DECIDED** (§3)                                | The declared result field type owns children at every depth; MAP's value-type rule is specified; absence ⇒ no inference. Measured: `Map<{key,value}>`, `Struct<{…}>`, `List<T>`, `Union<…>` all carry child types (probe §4).                                                        |
| 2. Record tree schema + hostile input | **DECIDED** (§4)                                | Schema-in/values-out, decode only inside the existing summary, markers and caps preserved; the quoting rule in §4.5 is decided here and overridable by the maintainer.                                                                                                               |
| 3. SQL result metadata                | **DECIDED — probed** (§5)                       | Type is **present** for computed expressions, function results and aliases and survives the wire, so parity is achievable without an engine/wire/projection change. Limits recorded: `TIMESTAMP_NS`, unmapped types, engine-version-dependent inference, `Time64`/`Utf8` label loss. |
| 4. Assertion disposition              | **DECIDED** (§6)                                | Four retargets, eight retentions, zero deletions; each change names its replacement.                                                                                                                                                                                                 |
| 5. Fixture/perf matrix                | **DECIDED in shape, UNDECIDED in numbers** (§7) | Fixtures and synthetic shapes are fixed and one fixture name is reserved; **performance thresholds are undecided** and must be set against a measured baseline in the runtime dispatch.                                                                                              |

Explicitly **not decided here** (deliberately left to the maintainer or to the runtime dispatch):

- Whether to approve any runtime work at all (this contract is the enabling artefact, not the
  approval).
- The exact performance thresholds of §7.4.
- The exact Arrow→label mapping implementation shape (`resultColumnTypes`'s signature is a
  specification, not an approved API).
- Whether §4.5's quarantine of the `Date` defensive branch (kept byte-identical, including its quoted
  root render) should ever be unified with the declared-type path. Out of scope; recorded as a known
  inconsistency rather than silently harmonised.

## 9. Approval gate and what a runtime dispatch would need

**Gate.** A maintainer approves this contract (or amends it) — a human action. The brief's stop rules
stay in force: no reopening of WFD-06 = B or the scalar scope; no engine/wire change; no
package-boundary crossing without an amendment; no weakened hostile-input totality; no "all temporal
displays fixed" claim; no usability claims from screenshots (D-02 A).

**Then, and only then,** a runtime dispatch would (in the brief's order) propagate declared child
types into `formatNestedPreview` and the Record tree, thread the result's declared field types through
`paged-query`/`SqlPanel` into `formatCell`, replace exactly §6.1's assertions, add §6.4's new ones,
generate §7.2's fixture, and record the residual (§5.5) instead of claiming a full fix — gated by the
brief's targeted e2e set plus the full local suite, with the mutation drill and byte-identical
restore.

Until that approval exists, this contract is the only artefact, and it authorises nothing.
