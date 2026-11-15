# D16/D17 composition probe — wrapped schema, restructured cast check, compose-time literal rewrite

**Date:** 2026-11-15 (UTC; the file name keeps the `20261114` this row's brief assigned). **Row:** EW-04D
verdict conditions (ii) **D16** and (iii) **D17** — read-only probe.
**Status:** probe complete; **no source, test, config, fixture, dependency or protocol change**; probes and
scripts under `/tmp/assay-d16-d17/`; nothing pushed, nothing committed.

**Authority:** [EW-04D](20261113-ew04-bulk-contract.md) §4.2/§4.4/§8/§9.1/§11 →
[U4 arm-class probe](20261114-u4-arm-class-probe.md) →
[post-R1 acceptance record](20261114-post-r1-decisions-accepted.md) (D4: "D16 = wrapped DESCRIBE +
restructured cast check (subject to the composition probe)"; "D17 = literal rewrite **iff** conformance
tests"). This record makes those accepted shapes concrete, prices them, and states whether they hold. It
does **not** re-open D11/D16/D17.

## 0. Baseline, and a live-mutation finding

- **Read-only checkout:** `/home/howt/work/dataworkbench`, branch `main`. The clean start I first saw
  (`3280e85…`, `git status --porcelain` 0 lines) exists **only in this session's transcript — no artifact
  captured it**, so it is reported as unproven. What the artifacts do show is a checkout that already
  carried another row's work: `/tmp/assay-d16-d17/baseline.txt` (the first file I wrote) records HEAD
  `f572707` with `M docs/adr/README.md`, `M …/20261114-post-r1-decisions-accepted.md` and
  `?? docs/adr/0049-csv-options-preview-and-retention.md`; `start-snapshot.txt` (10:52:07 Z) records
  `671c651`. §0.1 states the property that _is_ proven.
- **The checkout mutated under me, repeatedly.** Between 10:52 Z and 11:19 Z another row committed its work
  in this same working tree (`b99235a`, `f572707`, `671c651`, `5340579`); the 11:19 Z reading — empty
  `git diff`, this record the only untracked path — was **transient and is now superseded**: at the 11:51 Z
  check the checkout is `91379dc` (two commits further than `947267b`, which was HEAD when this correction
  round started) with a _second_ concurrent row's `docs/adr/0050-column-repair-undo-by-refold.md` untracked
  and `docs/adr/README.md` modified. So "main, clean" is not a property this row can claim at any point. Nothing below depends on the moved HEAD: the composer and
  its test keep the same sha256 throughout.
- **What did change in my authority chain:** `git diff 3280e85..5340579` touches only
  `docs/process/handoff.md`, the acceptance record's _authorization_ paragraph (U5 re-worded as the UI-free
  domain+engine slice, now ending "remains gated on the D14 ADR and on D16/D17 being pinned"), the new R2
  probe and the new CSV `0049` ADR — plus, after that, the concurrent `0050` ADR. The **D16/D17 acceptance
  rows are unchanged**, so the cited decisions are the ones this probe answers.
- **Pinned source of truth for composition:** `packages/engine-duckdb/src/overlay-query.ts`, sha256
  `85c9214af023a5614d0eab06609f03e47cfb9273bf25cff2cf9af162ed8b1ae0` at both ends of the probe; tests
  `overlay-query.test.ts`, sha256 `745be00ab3aaa43e468402acac1625767ff6891bf5af0b38fbbc757d28caeb97`.
  Line numbers below are that snapshot.
- **Tooling:** repo-pinned native CLI `/tmp/duckdb` v1.5.5 (Variegata) + Node v24.13.0. **No browser
  measurement was taken**; every wasm number quoted is U4's. No installs, no network, synthetic data only
  (`range()` views and ≤ 5-row `VALUES` tables; two clearly-labelled 200k/2M-row **scaling** views where a
  full-scan budget had to be measured at all).

### 0.1 Footprint proof

The only path I create is this record, and the proof is a **property**, not a clean tree: the composer and
its test keep the sha256 above at every check, and the tracked tree was byte-identical to my pre-write
snapshot whenever I looked (at 11:19 Z `git diff` was momentarily empty, `sha256 e3b0c442…`, with only this
record untracked). That reading is superseded — a second concurrent row then added `docs/adr/0050-…md` and
touched three files (§0). Every such path is theirs; none of my edits is outside this one file. Stated again
in §11.

### 0.2 Current composition (facts this probe builds on)

| Site            | Current shape (cited)                                                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema          | `DESCRIBE SELECT <eff exprs> FROM (<base inner>)` — **base branch only, no union** (`:845–857`, `:857`)                                         |
| Cast check      | existence probe, raw-literal arms + un-edited base arm + per-live-insert FROM-less arms, `LIMIT 1` (`:919–996`); R1-C elision at `:969–979`     |
| Window          | `SELECT <projection> FROM (<composeSourceSql union>)` (`:1026–1059`, projection at `:1044`)                                                     |
| Export          | same outer projection, `COPY`/Arrow (`:1087–1142`, projection at `:1137`)                                                                       |
| Base branch     | `SELECT <eff exprs> FROM (SELECT <base cols>, (row_number() OVER () - 1) AS assay_overlay_ord FROM <view>) [WHERE ord NOT IN (…)]` (`:708–741`) |
| Insert branches | one `SELECT` per live insert, every value `CAST(<literal> AS <effectiveType>)` (`:757–780`)                                                     |
| Literals        | `cellLiteralSql` → `CAST(<escaped literal> AS <effectiveType>)` (`:378–410`); raw form for the check (`:426–446`)                               |
| Caps / guards   | live-insert branches ≤ 500 (`:170`), reserved names (`:148`), effective types validated before SQL (`:577–581`)                                 |

Two facts the D16 work must respect, both still true:

1. **The repair does not exist in the composer.** Everything below is the shape a `column-repair` op would
   add; the maintainer's accepted direction is the input, not an implemented surface.
2. **The domain collapses a cast chain** to one direct `CAST(<raw value> AS final_type)`, which is _why_ the
   current cast check predicated on raw literals (m4-4b round 3, pinned by
   `overlay-query.test.ts:940–953`). §3.3 shows what that means for the restructure.

---

## 1. D16(a) — the wrapped `DESCRIBE`

### 1.1 Exact composed SQL

The wrapped shape reuses `composeSourceSql` with the count's options (`withRowIds: false`,
`sanitizeCsv: false`, `withKey: false`) and describes an **outer projection over the union**:

```sql
DESCRIBE SELECT "id" AS "id", "label_v2" AS "label_v2" FROM (
  <composeSourceSql>            -- base branch UNION ALL one branch per live insert
)
```

Empty overlay — this reuses the fixture whose **current, unwrapped** composition is pinned at
`overlay-query.test.ts:99–104`; that pin does not cover the wrapped shape, whose byte pin is future work
(§5.1.1):

```sql
DESCRIBE SELECT "id" AS "id", "label" AS "label" FROM (
  SELECT "id" AS "id", "label" AS "label"
  FROM (SELECT "id", "label", (row_number() OVER () - 1) AS assay_overlay_ord FROM "assay_t1")
)
```

One live insert, one edit, one tombstone:

```sql
DESCRIBE SELECT "id" AS "id", "label_v2" AS "label_v2" FROM (
  SELECT "id" AS "id",
         CASE WHEN assay_overlay_ord = 0 THEN CAST('edited' AS VARCHAR) ELSE "label" END AS "label_v2"
  FROM (SELECT "id", "label", (row_number() OVER () - 1) AS assay_overlay_ord FROM "assay_t1")
  WHERE assay_overlay_ord NOT IN (1)
  UNION ALL
  SELECT CAST(9 AS BIGINT) AS "id", CAST('ins' AS VARCHAR) AS "label_v2"
)
```

(The tombstone `WHERE` is irrelevant to `DESCRIBE` — no rows are produced — but it must be composed by the
same builder so the union is byte-identical to what window/export consume.)

**Where the ordinal and row-id columns go.** Nowhere in the described relation:

- `assay_overlay_ord` is created **inside** the base branch's inner subquery (`:717–719`) and never
  projected by the branch's outer `SELECT`, whose expression list is exactly the effective columns plus the
  optional row-id/key columns (`:720–724`, `:725–735`), so it cannot reach the union. It is a join key, not a
  column.
- `assay_row_id` is requested only by overlay **windows** (`withRowIds: includeRowIds`, `:1029–1032`) and is
  deliberately absent from exports — logical row ids are session-scoped (`:1087–1100`). The schema op must
  pass `withRowIds: false`, exactly as the count does (`:1007–1011`).
- `assay_key` is `withKey: false` here; and because the DESCRIBE projection is an explicit column list, it
  could not leak even if the union carried it. `assertNoReservedNames` (`:552–566`) still runs first, so a
  dataset column named like any of the three is still refused.

**Why the declared types cannot drift.** Every branch expression is _typed_ to `state.columns[i].type`:
the base branch is the base column (which already has that type) or `CAST(<base> AS <effectiveType>)`
(`:680–682`), edit arms are `cellLiteralSql(…)` = `CAST(<literal> AS <effectiveType>)` (`:685–689`), insert
branches are the same cast (`:757–780`). `UNION ALL` then resolves a column type to the _common_ type of
branches that all carry that one type. Probed (probe2, all identical-type pairs): `ENUM('a','b')`,
`DECIMAL(10,2)`, `INTEGER[]`, `STRUCT(a INTEGER)`, `TIME`, `UUID`, `BLOB`, `HUGEINT` all unify to
themselves; `DECIMAL(10,2) ∪ DECIMAL(12,4)` → `DECIMAL(12,4)` and `VARCHAR ∪ VARCHAR(5)` → `VARCHAR` show
the mechanism (unification _does_ widen when branch types differ — it just never differs here). The
parameterized spellings that would "widen" (`CHAR(3)`, `VARCHAR(5)`, `TIMESTAMP(3)`) are normalised by
DuckDB **at table creation**, before the composer ever sees them (probe3 F0: the base view already reports
`VARCHAR`/`TIMESTAMP_MS`).

### 1.2 Honest finding: this is enforcement, not a live bug fix

I could not construct a drift case against the **current** composer. Probe3 builds a table with `BIGINT`,
`VARCHAR`, `CHAR(3)`, `VARCHAR(5)`, `TIMESTAMP(3)`, `DECIMAL(10,2)`, `INTEGER[]`, `STRUCT`, an edit arm and
a live insert branch: the unwrapped DESCRIBE (base branch) and the wrapped DESCRIBE (union) return
**identical** `(column_name, column_type, null, key, default, extra)` tuples (F1–F4), and they match the
`typeof()` of the values the window actually returns (F5). So the type-preservation argument EW-04D §4.2
sketches for the _unwrapped_ option **is sound today** — it holds because "every branch is cast to
`<effectiveType>`" is true, and the wrapped shape converts that argument into something the engine enforces
per request.

The wrapped shape is still the right choice, for three reasons that cost nothing: (i) it is the same
projection the materializing ops use, so it cannot describe a relation the window does not produce; (ii) it
removes a per-site proof obligation that the repair work would otherwise have to re-establish (the insert
branch stops being a plain `CAST(lit AS T)` the moment a literal rewrite — D17 — rewrites the value); (iii)
it is the only shape that would _report_ the one drift the repair genuinely introduces: `trim()` returns
`VARCHAR` (probe1 A1/A2/B1–B4), so a repair on a `CHAR(n)`/`ENUM(…)` column silently re-declares that
column as `VARCHAR`. Both DESCRIBE shapes report that (they read the same expression); the wrapped one makes
it the reported truth. **New constraint that follows: a repair's column must be a `VARCHAR`/`TEXT`/`STRING`
spelling, not `ENUM`/`CHAR` — see §4.2.**

### 1.3 Cost, and two behavioural changes

`DESCRIBE` is **bind-only** — probe4 G1 describes a 2 M-row `md5()` view in ~1 ms. Measured (native, 1,000-row
base, medians of 3):

| Shape                          | SQL bytes | Time   |
| ------------------------------ | --------- | ------ |
| current `DESCRIBE`, m=500 arms | 20,546    | 5–7 ms |
| wrapped, k=0, m=0              | 193       | 1–3 ms |
| wrapped, k=1, m=0              | 276       | 2 ms   |
| wrapped, **k=500**, m=0        | 42,583    | 6 ms   |
| wrapped, **k=500, m=500**      | 62,971    | 9 ms   |

So the whole wrapped shape at both caps is ~9 ms native per schema request — planner-only and
session-bounded; on `eh` wasm the planner is ~4–6× `mvp`, so budget tens of ms, not seconds.

Two **behavioural changes** the §11 tests must pin, neither of which EW-04D records:

1. The schema op now flows through `composeSourceSql`, i.e. through
   `assertLiveInsertBranchBudget` (`:826–830`). A state with **more than 500 live inserts** therefore makes
   the _schema_ request throw `OverlayLiveInsertLimitError`, where today it describes the base branch and
   succeeds. That is self-consistent (every other op already fails), but it is a change.
2. The schema op must pass `sanitizeCsv: false`. With `true` the projection becomes the CSV guard, whose
   `CASE`/`chr(39)||…` arm and `hex()` arm both type as `VARCHAR` (`csvSafeExpression`, `:511–515`), so a
   **BLOB** column would be described as `VARCHAR` (probe19 A2/A4: `typeof(hex(b))` = `VARCHAR`,
   `typeof(b)` = `BLOB`). That is the one _real_ drift a careless caller can create. Non-gated classes are
   untouched: probe19 A3 pins `DECIMAL(10,2)`, `INTEGER[]`, `STRUCT(a INTEGER)` and `DATE` passing through
   `csvSafeExpression` unchanged, because `isStringLikeEngineType`/`isBlobLikeEngineType` are false for them.

---

## 2. D17 — the compose-time literal rewrite

### 2.1 The SQL it replaces

For a live insert whose value on the repaired column is the literal `L`, the per-branch form of the §1 wrap
would be (one expression per live insert, `m + 1` arms **each**):

```sql
CASE trim(CAST('<L>' AS VARCHAR), ' ' || chr(9) || chr(10) || chr(13))
     WHEN '<k1>' THEN CAST('<v1>' AS VARCHAR)
     …
     WHEN '<km>' THEN CAST('<vm>' AS VARCHAR)
     ELSE trim(CAST('<L>' AS VARCHAR), ' ' || chr(9) || chr(10) || chr(13))
END
```

### 2.2 The rewrite

Because `L` is a compile-time literal, the composer computes `r_literal(L)` in TypeScript and emits **one
literal, zero added arms**:

```sql
CAST('<r_literal(L)>' AS <effectiveType>)     -- NULL value  ⇒  CAST(NULL AS <effectiveType>)
```

where `r_literal` is, exactly:

1. `null` → `null` (a NULL cell is data; it never matches, and trim never produces NULL);
2. strip the maximal prefix **and** suffix run of characters from the closed set
   `{U+0020, U+0009, U+000A, U+000D}` (edge-only, repeated, interior untouched);
3. exact whole-value lookup of the _trimmed_ string in the mapping; hit → the mapped target, miss → the
   trimmed string;
4. re-enter the normal literal path: `assertWellFormedCellText` on the result (a mapping target is
   **new** user text and needs the same surrogate guard as any literal, `:340–358`) and `cellLiteralSql`
   escaping/typing (`:378–410`).

### 2.3 Equivalence evidence

`/tmp/assay-d16-d17/probe7-d17-equivalence.mjs` evaluates 26 hostile literals twice — TypeScript
`r_literal` and the SQL `CASE` above, compared by **md5 of the produced value** (so invisible-character
differences cannot pass) — plus `typeof`.

**Result: 26 cases, 0 TypeScript↔SQL disagreements.** (One case is marked `FAIL` in the transcript only
because my hand-written _expected_ column was wrong: `' \u00A0nb '` trims the leading space, so it _is_ a
map hit → `'NBSPKEY'`. TypeScript and SQL agreed; the annotation was wrong. Kept as evidence of the
method.) The covered classes, all of which the §11 tests must pin:

| Class                                                     | Probe result                                                                                                                                                                                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| plain / edge-trimmed hit, miss                            | `'alpha'`/`' alpha '` → `ALPHA`; `'beta'` unchanged                                                                                                                                                                                   |
| passthrough is the **trimmed** value                      | `'  alpha  x '` → `'alpha  x'` (interior kept)                                                                                                                                                                                        |
| CRLF and all four set chars                               | `'x\r\n'`, `'x\n\r\t '` → `'x'`                                                                                                                                                                                                       |
| all-set / empty ⇒ empty, never NULL                       | `'   '`, `' \t\n\r'`, `''` → `''`                                                                                                                                                                                                     |
| **NBSP / VT / FF / NEL / EM SPACE / BOM are NOT trimmed** | preserved verbatim — JS `String.prototype.trim()` would strip them, so it must not be used                                                                                                                                            |
| map on the trimmed value, binary equality                 | `'OLD'` unchanged; `'old '` → `new`                                                                                                                                                                                                   |
| quotes / backslashes                                      | `"quote'd"` → `escaped`; `back\slash` → `bs`                                                                                                                                                                                          |
| astral + non-ASCII BMP                                    | `'😀 alpha'`, `'héllo'` passthrough; `' alpha 😀 '` → `'alpha 😀'`                                                                                                                                                                    |
| NULL                                                      | `md5` of the wrap is NULL, never `''`                                                                                                                                                                                                 |
| **exactly once**                                          | applying the wrap twice yields `a→b→c` (`double-apply a: c`); applying it three times is the same `c`. So the literal path must _replace_ the wrap, never accompany it — otherwise two stacked repairs or a rewrite+wrap bug cascades |

### 2.4 The one caveat: non-text `CellValue` kinds

The insert value is a `CellValue`, so it can be `number`/`boolean` on a textual column (today rendered by the
engine's own cast — `cellLiteralSql`'s documented behaviour). The engine's rendering is not JS `String()`:

| value              | DuckDB `CAST(v AS VARCHAR)` | JS `String(v)`                 |
| ------------------ | --------------------------- | ------------------------------ |
| `1e-7::DOUBLE`     | `1e-07`                     | `1e-7`                         |
| `42.0::DOUBLE`     | `42.0`                      | `42`                           |
| `-0.0::DOUBLE`     | `0.0`                       | `0`                            |
| `1e21::DOUBLE`     | `1e+21`                     | `1e+21` (agrees)               |
| `0.1+0.2` (DOUBLE) | `0.30000000000000004`       | `0.30000000000000004` (agrees) |
| `TRUE`             | `true`                      | `true` (agrees)                |

So `r_literal` must be applied to `kind: 'string' | 'text'` only; for `number`/`boolean` the composer keeps
the SQL-side wrap for that branch (≤1 expression, session-bounded) or refuses the insert value. Either way
it is a compose-time branch the conformance tests pin — it is not an equivalence D17 can claim.

---

## 3. D16(b) — the restructured cast check

### 3.1 Why it is required, not optional

For a repair-composed column the check's current input is wrong. Today's check predicates on the **raw**
value because the domain collapses cast chains, so `CAST(<raw> AS target)` _is_ the committed conversion
(`:869–888`, test `overlay-query.test.ts:940–953`). Once a value transform sits in the prefix, the committed
conversion is no longer of the raw value — it is of the repair output (casts before the repair live inside
the wrap; casts after it apply outside, §4.2). A raw-arm check would then answer the wrong question, and the
"per-arm wrap" alternative EW-04D prices at `O((1+e+i)·(m+1))` would be _both_ expensive and still not the
committed expression.

**Consequence — and this is the one place the accepted direction needs a qualifier:** the restructure must be
**scoped to repair-composed columns**. For a repair-free column the current raw-arm shape must stay exactly
as it is; uniformly replacing it would re-introduce the m4-4b round-3 defect class, because the raw-arm
shape is the only one that sees the collapsed chain.

### 3.2 The accepted literal form, and why it cannot be emitted that way

Read literally — "outer projection over the wrapped effective value" — the check becomes:

```sql
SELECT 1 FROM (
  SELECT <the §1 wrap over the effective value> AS v
  FROM (<base inner>) [WHERE ord NOT IN (…)]
) WHERE v IS NOT NULL AND TRY_CAST(v AS <target>) IS NULL
UNION ALL SELECT 1 WHERE <wrap of each live-insert literal> IS NOT NULL AND TRY_CAST(…) IS NULL
LIMIT 1
```

This is faithful (it converts exactly the projected value) and satisfies `m + x + 1` arms **once** — but it is
**not affordable as a predicate**. Measured native, 200 k rows, m = 500, no failing row (the common "the cast
is fine, scan everything" case):

| Predicate shape                                           | 200 k rows (2 runs) |
| --------------------------------------------------------- | ------------------- |
| bare `TRY_CAST(col AS BIGINT)` (floor)                    | 0.014 s             |
| **wrap `CASE` as the filter operand** (this literal form) | **16.0 / 24.1 s**   |
| same, no `LIMIT`                                          | 22.5 / 23.4 s       |
| same wrap inside a `MATERIALIZED` CTE                     | 11.6 / 20.4 s       |
| split form (trim + `TRY_CAST` + 500-key `NOT IN`)         | 0.10 / 0.12 s       |
| current raw-arm chain, e = 500                            | 0.53 / 0.65 s       |

Extrapolated to a 2 M-row full scan: **≈ 120–240 s** for the literal form versus **≈ 1 s** for the split form
and ≈ 5–6.5 s for today's chain. DuckDB evaluates a 500-arm `CASE` as a linear arm chain in a filter, while a
long `IN (…)` list is set-optimised (probe9 K4: the 500-key key test alone costs 0.002 s per 200 k rows).
Materialsation does _not_ rescue the literal form (probe15). The same wrap **in a projection** is fine
(probe13 R2: 0.41 s per 200 k rows, 2.4 s per 2 M — the same order as U4's 3.95 s wasm export at m = 500),
which is why the window/export sites are unaffected and the _predicate_ site is the problem.

### 3.3 The split form (the concrete instantiation of the restructure)

The predicate is an algebraic decomposition of the same question — "does the projected value fail the
target conversion?" — with the mapping's constants pulled out of row scope:

```sql
SELECT 1 FROM (
  SELECT "<base>" AS v, assay_overlay_ord
  FROM (SELECT <base cols>, (row_number() OVER () - 1) AS assay_overlay_ord FROM "<view>")
  WHERE assay_overlay_ord NOT IN (<tombstones>)
) WHERE
  -- (x) exception rows: repair masked/not live at p — TODAY'S arms, unchanged,
  --     whether the value is the base column or an applied raw literal
  (assay_overlay_ord = o1 AND <raw lit 1> IS NOT NULL AND TRY_CAST(<raw lit 1> AS <T>) IS NULL)
  OR …
  -- (1) non-exception base rows: the repair applies
  OR (assay_overlay_ord NOT IN (o1, …, ox) AND v IS NOT NULL
      AND TRY_CAST(trim(v, ' ' || chr(9) || chr(10) || chr(13)) AS <T>) IS NULL
      AND trim(v, ' ' || chr(9) || chr(10) || chr(13)) NOT IN ('<k1>', …, '<km>'))
UNION ALL
-- (m) mapping targets: compose-time constants, one predicate each, no row scope
SELECT 1 WHERE TRY_CAST('<v1>' AS <T>) IS NULL OR … OR TRY_CAST('<vm>' AS <T>) IS NULL
UNION ALL
-- (i) live inserts: D17 rewrites the literal, so each arm is a constant
SELECT 1 WHERE TRY_CAST('<r_literal(insert value)>' AS <T>) IS NULL
LIMIT 1
```

Identity of the two forms (probe17, 13 values × 3 targets — `BIGINT`, `INTEGER`, `VARCHAR`): every
`(value set, target)` pair agrees, and the per-row account shows why (mapped rows are constants, passthrough
rows are `trim(v)`, NULL is excluded by the guard on both sides). `r(v)` is a **finite extension of the
identity**, which is exactly what makes the map extractable.

Properties of this shape:

- per-row work at a repair column is **1 trim + 1 `TRY_CAST` + one hashed set-membership** (O(1) in m);
  everything m-shaped is a constant predicate. It is _cheaper_ than today's `e`-arm chain;
- it keeps every m4-4b discipline: each value is `TRY_CAST`ed before any hard cast, the exception literals
  stay raw, and no literal is hard-cast to a type it is not committed under;
- it needs two composer branches: `m = 0` must omit the key test entirely (`x NOT IN ()` is a **syntax
  error** — probe17 T3), and `x = 0` omits the exception arms (as today, `:949–953`);
- `T` equal to the wrap's declared type (`VARCHAR`) makes the whole statement provably empty
  (`TRY_CAST(VARCHAR AS VARCHAR)` cannot fail, every constant is a string) — see §3.4.

### 3.4 What happens to the R1-C base-arm elision

Today (`:969–979`): with ≥1 edit and `targetType === effectiveType === baseColumn.type`, the _un-edited base
arm_ is elided because a base value already has the type; the _edit_ arms survive, because a raw literal can
still fail.

Under the split form on a repair column the elision **strengthens and moves**:

- the un-edited base arm survives only when the repair is not masked and `targetType ≠ <wrap's declared
type>`. When they are equal, the passthrough conjunct is `TRY_CAST(VARCHAR AS VARCHAR)`, which cannot fail,
  and every mapping constant is a string that converts to `VARCHAR` trivially → the **entire statement** is
  provably empty, not just the base arm. The composer should emit the empty check rather than scan;
- for a `targetType ≠ base` pending cast the elision must **not** fire: the passthrough rows and the mapping
  constants are exactly the failing classes (that is the check);
- a repair-free column keeps today's rule byte-for-byte.

So the R1-C elision is not lost — it generalises to "the check is empty iff the pending cast is a no-op on a
repair column **that the repair cannot break**", and its correctness argument changes from "a base value
already has the type" to "the wrap's declared type is the target type". That argument is only free if the
repair is restricted to string spellings whose casts are total (§4.2).

### 3.5 Multi-repair and the cast check — the one real cost gap

The split form composes further than one layer, because a repair stack is a finite extension of the identity:
`r_L∘…∘r_1` collapses at compose time into one finite map `keys = K_1 ∪ … ∪ K_L → constants` applied to
`trim(v)` (probe18: 18/18 against the stacked SQL, including non-commuting overlaps `alpha→ALPHA→alpha2`,
`a→b→c`, and keys whose edge whitespace makes them dead). If the composer does not do that collapse, a
multi-repair column's cast check needs the **stacked wrap as the per-row predicate** — the 12–24 s/200 k
shape — because there is no single `trim(v)` to test. That is the only site where "stacked projection
layers" is not automatically enough, and it is recorded as an open item (§9), not decided here.

---

## 4. Multi-repair composition (stacked projection layers only)

### 4.1 Shape

Each repair is **one projection layer**; layer _k_ reads layer _k−1_'s output column. Earliest repair
innermost:

```sql
SELECT <projection> FROM (
  SELECT …, <wrap_k over "col"> AS "col", …          -- layer k
  FROM (
    SELECT …, <wrap_1 over "col"> AS "col", …        -- layer 1
    FROM (<base branch UNION ALL insert branches>)
  )
)
```

Insert branches are not layered at all: each layer applies its `r_literal` to the literal in TypeScript, so
multi-repair at the insert site adds **zero** SQL.

### 4.2 Why the inner wrap must never be re-expanded

The same rule read as one nested expression — the inner wrap textually embedded in every outer arm — is
multiplicative and falsified. U4's measurement stands as the authority
([U4](20261114-u4-arm-class-probe.md) §2.2): one-expression nesting at 2 × 250 = **2,405,139 bytes / 2.35 s**
against 19,696 bytes / 17.6 ms for the stacked reading, and OOM at three. My native confirmation of the
_stacked_ reading (probe16, 200 k rows, forced evaluation): 2 × 250 = 21,355 bytes / 0.35–0.36 s,
3 × 166 = 28,399 bytes / 0.47–0.53 s, against 20,448 bytes / 0.41 s for a single 500-arm layer — additive in
layers, linear in Σ arms, no expression duplication.

**Emitted-SQL-size argument.** Arms and bytes are `O(Σ_k (m_k + x_k + 1))` plus one `trim` per layer; the
window keeps U4's measured `m ≤ 500` flat cost (14.7 ms plan / 16.6 ms exec at 1,000 rows, on `eh`) because
Σ arms is the only driver; the export keeps U4's execution-bound envelope (~4.0 s at m = 500 over 2 M rows,
`eh`), which my native probe13 R2 reproduces in kind (2.4 s at 2 M, 500 arms). The forbidden form is
`O(∏ m_k)` bytes.

---

## 5. Conformance cases the §11 tests must pin

Files (hypothetical reservation, per EW-04D §11 — nothing created here):

- `packages/engine-duckdb/src/overlay-query.test.ts` — byte pins for both new shapes (the existing
  `DESCRIBE`/cast-check pins at `:99–104`, `:887–892`, `:1118–1176` must be re-written, not deleted);
- `packages/engine-duckdb/src/overlay-repair-query.test.ts` (new) — repair wrap, literal rewrite, split check;
- `packages/domain/src/column-repair.test.ts` (new) — plan validation, caps, refusals, mask/liveness;
- `packages/testing/src/engine-conformance.ts` — two new scenarios (below) so the real engine executes them
  through `tests/e2e/engine-conformance.spec.ts` and `packages/engine-duckdb/harness/main.ts`;
- `packages/engine-duckdb/src/overlay-query.test.ts` is also where the two docs-only composer invariants
  (`sanitizeCsv: false`, `withRowIds: false` for the schema op) belong.

### 5.1 Schema (D16a)

1. **Wrapped projection, byte pin.** `composeOverlaySchemaSql` on the empty-overlay fixture is exactly
   `DESCRIBE SELECT "id" AS "id", "label" AS "label" FROM (SELECT "id" AS "id", "label" AS "label" FROM (…))`.
2. **Union present with inserts.** With one live insert the SQL contains `UNION ALL` and the insert branch's
   `CAST(9 AS BIGINT) AS "id"` / `CAST('ins' AS VARCHAR) AS "label"`; with zero live inserts it contains no
   `UNION ALL`.
3. **No machinery leak.** The composed schema SQL never contains `assay_overlay_ord`, `assay_row_id` or
   `assay_key`; a base column named `assay_key` still throws the reserved-name error.
4. **Type preservation against the engine** (real-engine scenario `overlay-repair-schema-types`): a base with
   `id BIGINT, label VARCHAR, amount DECIMAL(10,2), ratio DOUBLE, tags INTEGER[], rec STRUCT(a INTEGER),
note VARCHAR, label2 VARCHAR` plus a repair on `label` and a live insert — `overlaySchema()` must return
   exactly `BIGINT, VARCHAR, DECIMAL(10,2), DOUBLE, INTEGER[], STRUCT(a INTEGER), VARCHAR, VARCHAR`, equal to
   the types the window returns for the same state (F3/F5 evidence). Include a `NULL`-only column and a
   `DECIMAL` edit literal.
5. **The drift the wrapped shape reports.** A `CHAR(3)` and an `ENUM('a','b')` base column with a repair must
   come back as `VARCHAR` (probe1 A2/B4) — a **pinned** consequence, not an accident.
6. **No schema change from a plural of caps:** a state with 501 live inserts throws
   `OverlayLiveInsertLimitError` at the schema op (§1.3 change 1) while 500 succeeds.
7. **CSV guard never touches the schema.** `composeOverlaySchemaSql` output never contains `hex(` or
   `chr(39)` (the `sanitizeCsv: false` invariant, §1.3 change 2).

### 5.2 Cast check (D16b)

8. **Repair-free columns are byte-identical to today.** The four R1-C pins (`:1118–1176`) must still pass
   _unchanged_ — the restructure must not touch them.
9. **Repair column, real cast:** exact pinned string containing
   `TRY_CAST(trim("label", ' ' || chr(9) || chr(10) || chr(13)) AS BIGINT) IS NULL AND trim(…) NOT IN ('alpha', 'gamma')`,
   one `TRY_CAST(… AS BIGINT)` per mapping target **outside** any relation, and `LIMIT 1`.
10. **`TRY_CAST` vs exception arms:** a masked row's literal is tested raw
    (`assay_overlay_ord = 3 AND '5.5' IS NOT NULL AND TRY_CAST('5.5' AS …) IS NULL`), never through the wrap;
    a not-live-at-`p` row likewise; a tombstoned ordinal contributes no arm (as today, `:1391–1407`).
11. **No hard cast before its `TRY_CAST`:** the composed check contains no `CAST(` applied to a raw literal or
    to the base column — only `TRY_CAST`. (Reproduces the m4-4b round-3/4 discipline mechanically; this pin
    catches the ENUM/DATE class in §4.2.)
12. **The elision generalises:** for a repair column and `targetType === 'VARCHAR'` the composed SQL contains
    exactly one `TRY_CAST` (or none: pinned as the empty shape) and no `NOT IN (…key…)`; for `BIGINT` it
    contains both.
13. **`m = 0` and `x = 0` branches:** with no mapping pairs the SQL contains no `NOT IN ()`; with no
    exceptions no `assay_overlay_ord =` arm.
14. **Equivalence against the engine** (real-engine scenario `overlay-repair-cast-check`): for a fixed corpus
    (`'alpha'`, `' alpha '`, `'beta'`, `''`, `'   '`, `'5'`, `'5.5'`, `'not-a-number'`, `NULL`) and targets
    `BIGINT`/`INTEGER`/`VARCHAR`, `overlayCastCheck()` must equal "would the committed window throw",
    established by executing the corresponding window in a `try/catch`. Note the pre-existing oddity this
    exposes: `TRY_CAST('5.5' AS BIGINT)` **rounds to 6** (probe17 T2) — pin whatever the engine does, do not
    "fix" it here.

### 5.3 Literal rewrite (D17)

15. **The table itself** as literal assertions in `overlay-repair-query.test.ts`, one `expect` per row of the
    §2.3 classes, asserting the emitted `CAST('<…>' AS …)` bytes: `' alpha '` → `CAST('ALPHA' AS VARCHAR)`;
    `'  alpha  x '` → `CAST('alpha  x' AS VARCHAR)`; `'   '` → `CAST('' AS VARCHAR)`;
    `'\u00A0x\u00A0'` → unchanged (the anti-`trim()` pin); `'\u000Bx\u000C'`, `'\u0085x\u2003'`,
    `'\uFEFFx'` unchanged; `''` → `CAST('' AS VARCHAR)`; NULL → `CAST(NULL AS VARCHAR)`.
16. **Escaping and the surrogate guard on the output:** `"quote'd"` → `CAST('escaped' …)`; a mapping target
    containing `'` is doubled; a mapping target containing an unpaired surrogate throws the value-free error
    (the guard must run on the rewritten value, not only the input).
17. **Exactly once:** with `a→b, b→c` reachable only across two stacked repairs, a literal `'a'` must compose
    to `CAST('c' AS …)` (two layers) and _not_ `CAST('b' AS …)` (double application) — the probe7
    `double-apply` case as a test.
18. **Non-text values:** `{kind:'number', value:1e-7}` on a `VARCHAR` column must **not** go through
    `r_literal` (the `1e-07` vs `1e-7` divergence, §2.4); pin whichever branch is chosen, and pin
    `{kind:'boolean'}` too.
19. **Dead keys are refused or disclosed:** a mapping key whose edges are trim-set members (`' alpha'`) can
    never match, because the CASE operand is the trimmed value (probe18: keys are compared verbatim against
    `trim(v)`); assert the plan-level refusal/disclosure.
20. **Reserved-name shadowing at the insert site:** a repair on a column renamed in by an overlay still
    rewrites the branch aliased with the _effective_ name (`:757–780`), and a dataset column named
    `assay_row_id` still throws before any literal is built.

### 5.4 Multi-repair

21. **Stacked layers, byte pin:** two stacked repairs compose two nested `SELECT` layers, Σ(m+1) arms, and
    **no** repeated inner wrap — assert `sql.match(/trim\(/g)` has exactly 2 × (1 operand + 1 ELSE) per layer
    and that the byte length is within `O(Σ arms)` of the two single-layer compositions (probe16 numbers).
22. **Order:** `r1: old→middle`, `r2: middle→final` on a base row `'old'` composes nested layers **forward**
    (earliest innermost) and the window returns `'final'` (the §6.2 counterexample, now against the real
    composer — this is U5's job but the composer shape pin belongs here).
23. **Insert branches stay flat:** with two repairs and three live inserts, the number of `UNION ALL` branches
    is still 4, and each insert branch carries a single already-rewritten literal per repaired column.

---

## 6. Costs at the U4 shape

Native CLI (this probe) unless marked `eh` (U4's wasm measurement).

| Site / shape                                        | Size              | Time (1,000-row window)  | Time (full scan)                                |
| --------------------------------------------------- | ----------------- | ------------------------ | ----------------------------------------------- |
| window, flat wrap m=500 (`eh`, U4)                  | 19,345 B          | 14.7 ms plan / 16.6 exec | —                                               |
| window, stacked 2×250 / 3×166 (`eh`, U4)            | 19,696 / 19,443 B | 17.6 ms / 15.8 ms        | —                                               |
| one-expression nesting 2×250 (`eh`, U4)             | **2,405,139 B**   | 2.35 s                   | OOM at 3 repairs                                |
| export, m=500 over 2 M rows (`eh`, U4)              | —                 | —                        | **3,953.8 ms (execution-bound)**                |
| export wrap, m=500 over 2 M rows (native R2)        | 20,447 B          | —                        | **2.36 s** (agrees with U4's order)             |
| export, set-based map (mark join) over 2 M (native) | 8,986 B           | —                        | 1.00 s                                          |
| schema, current, base branch only, m=500            | 20,546 B          | **5–7 ms** (bind only)   | n/a (DESCRIBE does not execute)                 |
| schema, wrapped, k=0/500, m=0                       | 193 / 42,583 B    | 1–3 / 6 ms               | n/a                                             |
| schema, wrapped, k=500, m=500                       | 62,971 B          | 9 ms                     | n/a                                             |
| cast check, current chain e=500                     | 37,891 B          | —                        | 0.53–0.65 s per 200 k ⇒ ≈ 5–6.5 s per 2 M       |
| cast check, **literal wrapped-value form**, m=500   | 20,496 B          | —                        | **16–24 s per 200 k ⇒ ≈ 120–240 s per 2 M**     |
| cast check, **split form**, m=500                   | 4,089 B           | —                        | **0.10–0.12 s per 200 k ⇒ ≈ 1.0–1.3 s per 2 M** |
| window projection with the same wrap, forced, 200 k | 20,448 B          | —                        | 0.41 s                                          |

**Budget statement.** The window path is planner-plus-window-bounded and stays in the tens of ms (U4). The
**export path is execution-bound at ≈ 4.0 s per 2 M rows at the m = 500 cap** (U4, reproduced in kind
natively) and that is the number any published export envelope must use. The **cast check is a full-relation
pre-apply scan** and must be budgeted separately: with the split form it lands at ≈ 1 s per 2 M rows at
m = 500 (five times cheaper than today's chain), and with the literal wrapped-value form it lands at
≈ 2–4 minutes, which no pre-apply gate can hold.

---

## 7. Verdict

**D16(a) — wrapped `DESCRIBE`: holds.** It is faithful, costs ≤ ~9 ms native at both caps, and removes a
proof obligation instead of adding one. Two honest qualifiers: it fixes **no current drift** (I could not
construct one — probe3), so its value is enforcement, not a defect fix; and the §11 tests must pin the two new
behaviours it introduces (the insert-branch cap now applies to the schema op; the schema op must not sanitize).
The one drift the _repair_ introduces (`trim()` ⇒ `VARCHAR` re-declaration for `CHAR(n)`/`ENUM`) is reported
identically by both shapes and belongs to the plan-validation work in §4.2.

**D16(b) — restructured cast check: holds as a direction, with two required qualifiers.**

1. **Scope it to repair-composed columns.** The repair-free raw-arm shape must stay; replacing it uniformly
   abandons the collapsed-cast-chain reasoning that makes it correct today.
2. **Emit the split form, not the wrap as a predicate.** The literal reading is 100–200× more expensive in
   the existence-probe context (16–24 s per 200 k rows vs 0.10–0.12 s) — it would blow the pre-apply budget
   by two orders of magnitude at 2 M rows. The split form is equivalent (probe17), keeps every m4-4b
   discipline, satisfies `m + x + 1` arms emitted once (of which only 2 are per-row), and is _cheaper_ than
   the current check.

Both `m + x + 1` claims therefore survive — the check's _arm count_ is `m + x + 1` once, as accepted; what
changes is **where** the m arms live (compose-time constants, not a per-row chain). The R1-C elision is not
lost: it generalises from "the base value already has the type" to "the wrap's declared type is the target".

**D17 — compose-time literal rewrite: holds, conditional on the conformance pins.** 26/26 literal cases agree
by md5, including the anti-`trim()` set, CRLF, NBSP/VT/FF/NEL/EM-space/BOM, quotes, backslashes, astral
characters, empty-vs-NULL and single application. It is **0 arms** at the insert site versus `m + 1` per live
insert. The three obligations are (i) an explicit code-point set, never `String.prototype.trim()`;
(ii) exactly-once application (or the map cascades); (iii) `string`/`text` kinds only — the engine's rendering
of `number`/`boolean` diverges from `String()`.

**What does not hold as accepted, stated plainly:** the phrase "restructured cast check over the wrapped
effective value" cannot be taken literally at the emitted-SQL level, and the repair can only be composed onto
a **varchar-family, total-cast** column. Neither is a re-decision; both are preconditions the §11 tests must
carry.

### 7.1 New constraints this probe found (not in EW-04D)

1. **Repair column type.** `trim(<non-text>)` is a **Binder Error** (`trim(DATE)`, `trim(INTEGER)`), and
   `trim(CAST(x AS ENUM(…)))` types as `VARCHAR` while `CAST('zzz' AS ENUM(…))` throws. So the repair column
   must be `VARCHAR`/`TEXT`/`STRING` — **not** `ENUM` and not `CHAR`/`BPCHAR` unless the type
   re-declaration is accepted. `isStringLikeEngineType` (`type-expr.ts:615–621`) is _not_ a sufficient gate: it
   includes `ENUM` (`type-expr.ts:142–151`). A dedicated narrower predicate and a typed value-free refusal at
   plan construction are needed.
2. **Cast-chain collapse must become per-segment.** Casts _before_ the repair collapse into the wrap's input
   type (which must stay textual); casts _after_ apply outside the wrap. The domain's
   "collapse to one direct cast" rule cannot span a repair, or the wrap would end up trimming an `INTEGER`.
3. **Mapping keys with trim-set edges are dead entries** (the operand is always the trimmed value). Refuse or
   disclose at plan construction.
4. **`DESCRIBE` never executes**, so the wrapped schema is bind-only — worth stating in the cost notes so a
   future reader does not add a scan guard.
5. **DuckDB evaluates CASE arms linearly and `IN (…)` set-wise.** Any future "wrap in a predicate" proposal
   (counts over repaired values, filters on repaired values) must be checked against §6's two-orders-of-
   magnitude penalty.

---

## 8. What this probe does not prove

- **No browser/wasm measurement.** Every per-statement cost above is native v1.5.5. The wasm numbers are
  U4's; the wasm _planner_ ratio (4–6× `mvp`) and the export envelope are U4's, not re-measured here. The one
  new cost claim (the CASE-as-predicate penalty) is **native-only and unexplained at the plan level** — I
  measured it four times (probe9 K3, probe10 L0–L2/L5, probe14 P0/P1, probe15) but did not inspect `EXPLAIN`
  output to name the operator; the _ratio_ is stable, the mechanism is inferred.
- **A differential against the real domain fold** (U5's job). Probe17/18 model `trim∘map` and the forward
  composition exactly as EW-04D §6.2 states them; the composer equivalence is U5.
- **No implementation**: no `column-repair` op, no composer branch, no wire parser. The byte pins above are
  the shapes I measured, not shipped SQL.
- **The exact `x` (exception-arm) semantics under multi-repair** — the ≤ 2^L mask slices a stacked
  composition can produce — was not probed; §3.5 and §5.4 record the obligation.

## 9. ADR candidate

One durable decision is not covered by any existing ADR: **the composition shape of a value-transform op
family** — (a) multi-repair prefixes compose as **stacked projection layers** whose emitted size is linear
(`O(Σ(m_k + x_k + 1))` bytes and arms, never `O(∏ m_k)`), and (b) **predicate sites use set-membership, not
CASE arm chains**, because the two are 100–200× apart in the existence-probe context. Proposed record:
`docs/adr/0051-column-repair-composition-shape.md` — `0051` is the next free number at the time of writing
(`0049` = the CSV options ADR, `0050` = the concurrent row's column-repair undo-by-refold ADR); renumber if a
racing row claims it first. It is durable independent of whether EW-04I ships: it constrains any future
value-transform op, and it is the difference between a 1 s and a 2-minute pre-apply gate. Not written in this
row.

## 10. Probe transcript

Scripts and outputs under `/tmp/assay-d16-d17/` (`gen/` holds generated SQL). All native `/tmp/duckdb` v1.5.5.

| #   | File                                                  | What it showed                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `probe1-types.sql`                                    | `trim()` → `VARCHAR` for `VARCHAR`/`CHAR(3)`; **`trim(DATE)`/`trim(INTEGER)` are Binder Errors**; the §1 wrap types as `VARCHAR` for every string spelling incl. `ENUM`; `CAST('toolong' AS CHAR(3))` truncates without error; `CAST('zzz' AS ENUM(…))` throws. §4.2 constraint 1.                                                                                                                     |
| 2   | `probe2-unify.sql`                                    | `UNION ALL` unification: `ENUM`/`DECIMAL`/`INTEGER[]`/`STRUCT`/`TIME`/`UUID`/`BLOB`/`HUGEINT` self-identical; `DECIMAL(10,2) ∪ DECIMAL(12,4)` → `DECIMAL(12,4)`; `VARCHAR ∪ VARCHAR(5)` → `VARCHAR`.                                                                                                                                                                                                   |
| 3   | `probe3-describe.sql`                                 | Current vs wrapped `DESCRIBE` over an 8-column typed table with an edit and a live insert — **identical** results (F1–F4), matching `typeof()` of the window projection (F5). No current drift.                                                                                                                                                                                                        |
| 4   | `probe4-describe-cost.sql`                            | `DESCRIBE` is bind-only (~1 ms over a 2 M-row `md5()` view); 100 insert branches add ~5 ms.                                                                                                                                                                                                                                                                                                            |
| 5   | `probe5-cost-out.txt` + `gen/`                        | First cost matrix (schema/cast shapes at 1,000 rows). Superseded in part by 13–15; kept as evidence that the 1,000-row shapes are _not_ where the cost lives.                                                                                                                                                                                                                                          |
| 6   | `probe6-castcheck.sql`                                | First attempt at the cast-check shapes. **Two constructions were wrong and are kept as evidence**: S1 omitted `LIMIT 1` so "expect 1 row" produced 4; S3's "wrapped" shape hard-cast an edit literal (`CAST('x' AS BOOLEAN)`) and _threw_, which is exactly the throw class §3.2/§7.1 chase.                                                                                                           |
| 7   | `probe7-d17-equivalence.mjs` (rev 2)                  | 26 hostile literals, TS `r_literal` vs SQL `CASE`, **0 disagreements**; `double-apply a: c`; the non-text rendering table (§2.4). Rev 1 is kept in the file's header: it interpolated its argument as a _literal_, so all 25 md5s were identical — a probe bug, fixed, not a semantic finding.                                                                                                         |
| 8   | `gen/probe8-scaling.sql` + `probe8-scaling-out.txt`   | Executor scaling of the cast shapes at 200 k rows. Superseded by 9/13/14 (its data was configured so the probe exited early).                                                                                                                                                                                                                                                                          |
| 9   | `gen/probe9-forms.sql` + `probe9-forms-out.txt`       | **The key finding**: the 500-arm wrap as a filter operand = 12.2–12.5 s/200 k vs 0.054 s for the split form; the 500-key `NOT IN` alone = 0.002 s; mark-join membership = 0.034 s.                                                                                                                                                                                                                     |
| 10  | `gen/probe10-hoist.sql` + `probe10-hoist-out.txt`     | Hoisting the trim into a subquery does not help (11.5–12.1 s); trim alone 0.025 s; identity 0.006 s — so the arm chain, not the trim, is the cost.                                                                                                                                                                                                                                                     |
| 11  | `gen/probe11-u4shape.sql` + `probe11-u4shape-out.txt` | Cautionary: some shapes looked free because `count(*)` lets the projection be pruned. Drove the switch to forced evaluation (`sum(length(v))`) in 13.                                                                                                                                                                                                                                                  |
| 12  | `gen/probe12-bisect.sql` + `probe12-bisect-out.txt`   | Bisect: searched CASE over `trim(...)` = 9.4 s vs over a plain column = 0.024 s (same rows, same predicate); a view column = 3.4 s. Confirms the computed-operand penalty.                                                                                                                                                                                                                             |
| 13  | `gen/probe13-forced.sql` + `probe13-forced-out.txt`   | Forced-evaluation projection costs: 200 k R1/R2/R3/R4 = 0.215/0.406/0.113/0.105 s; 2 M = 2.03/2.36/0.87/1.00 s — **the wrap in a projection is the U4 order (~2.4 s at 2 M), the wrap in a predicate is not**.                                                                                                                                                                                         |
| 14  | `gen/probe14-limit.sql` + `probe14-limit-out.txt`     | A/B with and without `LIMIT 1`: wrap predicate 16.0/24.1 s (with) and 22.5/23.4 s (without); split 0.12/0.10 s; current chain 0.53/0.65 s; floor 0.014 s. It is not a `LIMIT` effect.                                                                                                                                                                                                                  |
| 15  | `gen/probe15-cte.sql` + `probe15-cte-out.txt`         | `MATERIALIZED` CTE does not rescue the wrap-as-predicate (11.6–22.5 s); its `DESCRIBE` still types `v` as `VARCHAR`.                                                                                                                                                                                                                                                                                   |
| 16  | `gen/probe16-stacked.sql` + `probe16-stacked-out.txt` | Stacked layers are additive: 2×250 = 21,355 B / 0.35 s, 3×166 = 28,399 B / 0.47–0.53 s (200 k rows) vs a single 500-arm layer at 20,448 B / 0.41 s.                                                                                                                                                                                                                                                    |
| 17  | `probe17-split-equivalence.sql`                       | Split ≡ wrap on 13 values × 3 targets; per-row account; **`x NOT IN ()` is a Parser Error** (the `m = 0` composer branch); `TRY_CAST('5.5' AS BIGINT)` = 6.                                                                                                                                                                                                                                            |
| 18  | `probe18-collapse.mjs`                                | A repair stack is a finite extension of the identity: stacked SQL = TS two-layer = collapsed finite map, **18/18**, incl. non-commuting `alpha→ALPHA→alpha2`, `a→b→c`, and a dead whitespace-edge key.                                                                                                                                                                                                 |
| 19  | `probe19-csvguard.sql`                                | What a `sanitizeCsv: true` schema projection would declare: `typeof(<formula guard>)` = `VARCHAR`, `typeof(hex(b))` = `VARCHAR` vs `typeof(b)` = `BLOB` (the BLOB drift), and `DECIMAL(10,2)` / `INTEGER[]` / `STRUCT(a INTEGER)` / `DATE` **unchanged** (`csvSafeExpression` returns them verbatim). First run failed on its own bad literal (`'x'::DECIMAL(10,2)`) — kept in the output as evidence. |

## 11. Gates (docs-only) and footprint

`pnpm exec prettier --write` on this record, then `pnpm format:check`, `pnpm docs:links:check`,
`pnpm adr:index:check`, `git diff --check`. **No unit, build, lint or browser claim is made**; the composer and
its tests were read, never executed, and no figure here comes from a test run of this repository.

Footprint: the only new path attributable to this row is this file. The clean-tree reading was taken once
(11:19 Z: empty `git diff`, `sha256 e3b0c442…`, only this file untracked) and is **superseded** — at the
11:51 Z check the checkout is `91379dc` with a second concurrent row's `docs/adr/0050-…md` untracked and
`docs/adr/README.md` modified. Those paths are not mine, and none of my edits is outside this file. The checkout's HEAD moved throughout the probe (§0) — recorded rather than
papered over. Nothing pushed, nothing committed.

_Probe-only status: analysis and measurements; no source, test, config, fixture, dependency or protocol
change; no approval claimed; D16/D17 remain the maintainer's decisions._
