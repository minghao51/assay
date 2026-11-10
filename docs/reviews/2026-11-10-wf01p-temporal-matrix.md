# WF-01P — read-only temporal matrix (evidence for the WFD-06 decision)

**Status:** observed evidence, awaiting a maintainer decision. This document **authorizes nothing**: WF-01
runtime stays blocked until the maintainer approves or amends the scope-A contract in §7 and answers the
single question in §13. Produced under row WF-01P of the
[web follow-up map](../process/handoff/20261110-web-followup-map.md) as approved in the
[approval record](../process/handoff/20261110-web-followup-approval.md) (2026-11-10), against the
contract in [spec §4.1](../product/14-web-interface-followup-spec.md).

**Provenance:** the body below is the read-only investigation agent's verbatim deliverable, produced at
`4051704` with no repository edit (main checkout byte-identical afterwards). Its raw logs lived under
`/tmp/assay-wf-01p/` and are ephemeral; §1 records the exact reproduction commands, and every table value
in §2–§6 was machine-rendered from `logs/probe.json`, not hand-typed.

**Orchestrator spot-check (2026-11-10):** main checkout clean at `4051704`, no stray worktree/branch;
`temporalDraft` in `apps/web/src/edit/typed-input.ts` matches the §8 extraction claim (DATE ms → UTC
`YYYY-MM-DD`; TIMESTAMP ms → ISO `…sssZ`; TIME bigint µs → `HH:mm:ss[.ffffff]`); the fractional-ms and
TIME-bigint values in §2/§5 trace back to the recorded probe JSON.

---

# WF-01P — read-only temporal matrix (observed, not inferred)

**Row:** WF-01P / T-WF01P (read-only preflight for WF-01). **Nothing in the repository was changed.**
**Baseline SHA:** `40517041db1121b5acbf8ff055dcd133ec815fe6` (main checkout, `4051704`).
**Probe location:** throwaway detached worktree `/tmp/assay-wf01p` (same SHA) + `/tmp/assay-wf-01p` for fixture/logs.
**Main checkout state at end:** `git status --porcelain` empty, no branch/commit/stash/untracked file; worktree removed.

Engine actually exercised: **DuckDB-WASM 1.32.0 → DuckDB `v1.4.3`**, Apache Arrow **17.0.0**, Chromium (Playwright 1.63) with the repository's own `DuckDbEngineClient`, its worker protocol, its Arrow IPC transport, `DuckDbGridProvider` (base fast path **and** overlay path), and the app's own `formatCell` / `composeCellCopyText` / `cellEditDraft` / `formatNestedPreview` / `buildRecordTree` at the pinned SHA. Application source was **not** patched; the probe imports it.

---

## 1. Probe method + exact commands

| Step                  | Command (all probe-only)                                                                                                                                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scratch worktree      | `git -C /home/howt/work/dataworkbench worktree add --detach /tmp/assay-wf01p 4051704`                                                                                                                                      |
| Dependency resolution | root/package `node_modules` **symlinked** from the main checkout (read-only use; no install)                                                                                                                               |
| Synthetic fixture     | `/tmp/duckdb < /tmp/assay-wf-01p/gen2.sql` (CLI **v1.5.5**, the repo's own pinned CLI version) → `/tmp/assay-wf-01p/wf01p-temporal.parquet` (2 rows: one full row, one all-NULL row)                                       |
| Probe page            | `/tmp/assay-wf01p/packages/engine-duckdb/harness/probe.html` + `probe.ts` (probe-only, imports app source)                                                                                                                 |
| Dev server            | `node <vite>/bin/vite.js --port 4199 --strictPort` (cwd `packages/engine-duckdb`, `root: harness`)                                                                                                                         |
| Runner                | `node <playwright>/cli.js test -c playwright.wf01p.config.ts` (spec `tests/e2e/wf01p-probe.spec.ts`, imports `./support/fixture` so DuckDB extensions are served from the repo's committed pinned binaries, never the CDN) |
| Matrix render         | `node /tmp/assay-wf-01p/render-matrix.mjs /tmp/assay-wf-01p/logs/probe.json`                                                                                                                                               |

What this exercises for real: the DuckDB-WASM worker, the `engine/*` protocol, `DESCRIBE` type strings as `schema()` returns them, Arrow IPC → `tableFromIPC` → `vector.get(row)` (i.e. `projectBatchToRows` / `projectOverlayPage`), and the DOM formatters with the exact arguments the components pass. What it does **not** exercise: React rendering itself (§11).

**Probe coverage:** 44 live expressions (1 failed — see §10), 27 base-table columns × 2 rows, 27 overlay-window columns × 2 rows, 152 described cells, plus profile, record-tree, alias and precision probes.
**Row labels:** **every** row below is app-path/engine-path observed data. No matrix row depends on the DuckDB CLI; the CLI was used only to _write_ the synthetic Parquet. Nothing is labelled `package-only`. One row is labelled **unobserved** (`AT TIME ZONE` — ICU extension unavailable, §10).

---

## 2. Matrix — type / Arrow / delivered JS / consumers / meaning / precision / fallback

### 2.1 The seven required columns

| #   | 1. DuckDB type string (as delivered by `schema()`)                                                                        | 2. Arrow field type + unit                               | 3. JS shape — base path                                                                                                                                         | 3. JS shape — overlay path                     | 4. Declared type available at consumer? (grid / copy / editor / nested / Record / SQL)                                                          | 5. UTC / naive / zoned meaning implied                                                                                 | 6. Delivered precision (vs DuckDB's own text)                                                                                                                  | 7. Current safe fallback                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 1   | `DATE`                                                                                                                    | `Date32<DAY>` (unit=`DAY`)                               | **number**, epoch **ms**, integral (`1709164800000`)                                                                                                            | **identical** number                           | grid ✓ (`column.type` + parsed tree) / copy ✓ / editor ✓ (parsed tree) / nested ✓ (type passed, unused for temporal) / **Record ✗** / **SQL ✗** | UTC calendar day; no zone exists in the type                                                                           | ms = exact day (DuckDB text `2024-02-29`; `delivered*1000` integral)                                                                                           | raw number string                                                                 |
| 2   | `TIMESTAMP` (also what `TIMESTAMP_S`/`TIMESTAMP_MS` **become after a Parquet round-trip**, and what `DATETIME` prints as) | `Timestamp<MICROSECOND>` (unit=`MICROSECOND`, **no tz**) | **number**, epoch **ms**, can be **fractional** (`1709214312123.456`; pre-1970 `-0.001`)                                                                        | **identical**                                  | grid ✓ / copy ✓ / editor ✓ / nested ✓ / **Record ✗** / **SQL ✗**                                                                                | naive wall time; the projection treats it as if UTC — the original timezone was never in the value                     | µs are delivered but folded into a float ms; `Math.round(v*1000)` recovered the exact µs for this value (see §5)                                               | raw number string                                                                 |
| 3   | `TIMESTAMP_S`                                                                                                             | `Timestamp<SECOND>` (unit=`SECOND`)                      | **number**, epoch ms, integral (`1709214312000`)                                                                                                                | identical                                      | as #2                                                                                                                                           | naive; sub-second precision never existed                                                                              | whole seconds                                                                                                                                                  | raw                                                                               |
| 4   | `TIMESTAMP_MS`                                                                                                            | `Timestamp<MILLISECOND>` (unit=`MILLISECOND`)            | **number**, epoch ms, integral (`1709214312123`)                                                                                                                | identical                                      | as #2                                                                                                                                           | naive                                                                                                                  | ms exactly                                                                                                                                                     | raw                                                                               |
| 5   | `TIMESTAMP_NS`                                                                                                            | `Timestamp<NANOSECOND>` (unit=`NANOSECOND`)              | **number**, epoch ms **fractional** (`1709214312123.4568`; pre-1970 `-0.000001`)                                                                                | **identical**                                  | as #2                                                                                                                                           | naive                                                                                                                  | **ns are already lost**: DuckDB text is `.123456789`, delivered float resolves only to ~100 ns and `delivered*1000` is **not** integral (`1709214312123456.8`) | raw                                                                               |
| 6   | `TIMESTAMP WITH TIME ZONE` (engine prints this; the `TIMESTAMPTZ` alias **never** appears in a delivered schema)          | `Timestamp<MICROSECOND, UTC>` (UTC flag set)             | **number**, epoch ms (UTC instant; `1709194512123.456`)                                                                                                         | **identical**                                  | as #2                                                                                                                                           | **zoned instant**; storage is UTC, the input offset (`+05:30`) is **unrecoverable** — DuckDB text already reads `…+00` | µs delivered as float ms (exact µs recoverable here)                                                                                                           | raw                                                                               |
| 7   | `TIME`                                                                                                                    | `Time64<MICROSECOND>` (unit=`MICROSECOND`)               | **bigint**, µs since midnight (`49512123456`)                                                                                                                   | **identical** bigint                           | as #2 (`editorKind` = `temporal`)                                                                                                               | wall-clock time, **no date, no zone**; must never be mapped to a Unix instant                                          | µs exact                                                                                                                                                       | raw bigint string                                                                 |
| 8   | `TIME WITH TIME ZONE` (engine prints this for a `TIMETZ` column)                                                          | `Time64<MICROSECOND>` — **no tz in the Arrow type**      | **bigint** µs (`49512123456`, byte-identical to plain `TIME '13:45:12.123456'`)                                                                                 | not probed (cannot be stored in Parquet — §11) | as #2, **but** the alias string `TIMETZ` maps to `editorKind: text` while `TIME WITH TIME ZONE` maps to `temporal`                              | **the declared type claims a zone the value cannot carry — the offset is unrecoverable at the projection boundary**    | µs, offset dropped                                                                                                                                             | raw bigint string                                                                 |
| 9   | `INTERVAL`                                                                                                                | `Interval<MONTH_DAY_NANO>` (unit=`MONTH_DAY_NANO`)       | **object** — an `Int32Array`-like view (8 bytes)                                                                                                                | identical                                      | grid ✓ (but not the temporal family) / Record ✗ / SQL ✗                                                                                         | duration, not a timestamp; not a date at all                                                                           | not decoded by the app                                                                                                                                         | `<8 bytes>`                                                                       |
| 10  | `BIGINT` (`Int64`), `UBIGINT` (`Uint64`)                                                                                  | `Int64` / `Uint64`                                       | **bigint** (`9007199254740993`, `18446744073709551615`)                                                                                                         | identical                                      | grid ✓ / editor ✓ (`number` kind)                                                                                                               | **ordinary integer — must never be reinterpreted as temporal**                                                         | exact                                                                                                                                                          | raw decimal string                                                                |
| 11  | `DECIMAL(p,s)` / `HUGEINT`                                                                                                | `Decimal[18e+6]` / `Decimal[38e0]`                       | **object** (`DecimalBigNum`, a `Uint32Array` subclass view)                                                                                                     | identical                                      | grid ✓ (decoded **only** because the declared type is passed) / SQL ✗ (`<16 bytes>`)                                                            | ordinary numeric                                                                                                       | exact via declared type                                                                                                                                        | `<16 bytes>` without a type                                                       |
| 12  | `DOUBLE` / `INTEGER` / `VARCHAR` / `BOOLEAN`                                                                              | `Float64` / `Int32` / `Utf8` / `Bool`                    | number / number / string / boolean                                                                                                                              | identical                                      | grid ✓                                                                                                                                          | **not temporal**; `VARCHAR '2024-02-29 13:45:12'` stays a string, `DOUBLE Infinity` stays `Infinity`                   | n/a                                                                                                                                                            | unchanged                                                                         |
| 13  | `NULL` in any temporal column                                                                                             | as the column's type                                     | **`null`**                                                                                                                                                      | identical                                      | —                                                                                                                                               | —                                                                                                                      | —                                                                                                                                                              | `''` in grid, `null` from `composeCellCopyText`, `''` draft, `null` preview       |
| 14  | `DATE[]`, `STRUCT(ts TIMESTAMP, d DATE, t TIME)`                                                                          | `List<Date32<DAY>>`, `Struct<{…}>`                       | list `Vector` / `StructRow` whose **temporal children are plain numbers/bigints** (`{"ts":1709164800000,"d":1709164800000,"t":0}`, `[1709164800000,-86400000]`) | identical                                      | nested ✓ (child types known, still raw) / Record ✗ / SQL ✗                                                                                      | same as the leaf types                                                                                                 | child µs survive only as fractional ms                                                                                                                         | raw JS-ish text (`{"ts":…}`, `[…]`)                                               |
| 15  | `TIMESTAMP 'infinity'` / `'-infinity'`                                                                                    | `Timestamp<MICROSECOND>`                                 | **`vector.get()` THROWS** `TypeError: 9223372036854775 is not safe to convert to a number.` (arrow `getTimestampMicrosecond` → `divideBigInts`)                 | throws too                                     | unreachable                                                                                                                                     | not representable                                                                                                      | not delivered                                                                                                                                                  | **no fallback exists — the throw happens in the projection, before `formatCell`** |

**Observed invariant:** in **0 of 152** described cells did a temporal column deliver a JS `Date`. `formatCell`'s `value instanceof Date` branch (and the same branch in `nested-preview.ts` / `typed-input.ts`'s generic path) never fires on real engine payloads at this SHA.

### 2.2 Machine-rendered table (every value below comes from `logs/probe.json`)

### Rendered from logs/probe.json (machine-generated, not hand-typed)

| #   | DuckDB type (as delivered)                    | Arrow field type + unit                | base-path cell                       | overlay-path cell                    | grid scalar `formatCell(v,type,parsed)` | focused copy `composeCellCopyText(...)` | SQL cell `formatCell(v)` | editor draft `cellEditDraft(v,parsed)` | editor kind | Record tree / nested preview summary |
| --- | --------------------------------------------- | -------------------------------------- | ------------------------------------ | ------------------------------------ | --------------------------------------- | --------------------------------------- | ------------------------ | -------------------------------------- | ----------- | ------------------------------------ |
| 1   | `DATE` → `DATE`                               | `Date32<DAY> (unit=0)`                 | number `1709164800000`               | number `1709164800000`               | `1709164800000`                         | `1709164800000`                         | `1709164800000`          | `2024-02-29`                           | temporal    | `1709164800000`                      |
| 2   | `DATE (pre-1970)` → `DATE`                    | `Date32<DAY> (unit=0)`                 | number `-86400000`                   | number `-86400000`                   | `-86400000`                             | `-86400000`                             | `-86400000`              | `1969-12-31`                           | temporal    | `-86400000`                          |
| 3   | `DATE (epoch)` → `DATE`                       | `Date32<DAY> (unit=0)`                 | number `0`                           | number `0`                           | `0`                                     | `0`                                     | `0`                      | `1970-01-01`                           | temporal    | `0`                                  |
| 4   | `DATE (far, out of JS range)` → `DATE`        | `Date32<DAY> (unit=0)`                 | number `8640009504000000`            | number `8640009504000000`            | `8640009504000000`                      | `8640009504000000`                      | `8640009504000000`       | `8640009504000000`                     | temporal    | `8640009504000000`                   |
| 5   | `DATE (infinity)` → `DATE`                    | `Date32<DAY> (unit=0)`                 | number `185542587100800000` (unsafe) | number `185542587100800000` (unsafe) | `185542587100800000`                    | `185542587100800000`                    | `185542587100800000`     | `185542587100800000`                   | temporal    | `185542587100800000`                 |
| 6   | `TIMESTAMP` → `TIMESTAMP`                     | `Timestamp<MICROSECOND> (unit=2)`      | number `1709214312123.456` (unsafe)  | number `1709251200500`               | `1709214312123.456`                     | `1709214312123.456`                     | `1709214312123.456`      | `2024-02-29T13:45:12.123Z`             | temporal    | `1709214312123.456`                  |
| 7   | `TIMESTAMP (pre-1970 sub-ms)` → `TIMESTAMP`   | `Timestamp<MICROSECOND> (unit=2)`      | number `-0.001` (unsafe)             | number `-0.001` (unsafe)             | `-0.001`                                | `-0.001`                                | `-0.001`                 | `1970-01-01T00:00:00.000Z`             | temporal    | `-0.001`                             |
| 8   | `TIMESTAMP (midnight)` → `TIMESTAMP`          | `Timestamp<MICROSECOND> (unit=2)`      | number `1709164800000`               | number `1709164800000`               | `1709164800000`                         | `1709164800000`                         | `1709164800000`          | `2024-02-29T00:00:00.000Z`             | temporal    | `1709164800000`                      |
| 9   | `TIMESTAMP_S` → `TIMESTAMP`                   | `Timestamp<MICROSECOND> (unit=2)`      | number `1709214312000`               | number `1709214312000`               | `1709214312000`                         | `1709214312000`                         | `1709214312000`          | `2024-02-29T13:45:12.000Z`             | temporal    | `1709214312000`                      |
| 10  | `TIMESTAMP_MS` → `TIMESTAMP`                  | `Timestamp<MICROSECOND> (unit=2)`      | number `1709214312123`               | number `1709214312123`               | `1709214312123`                         | `1709214312123`                         | `1709214312123`          | `2024-02-29T13:45:12.123Z`             | temporal    | `1709214312123`                      |
| 11  | `TIMESTAMP_NS` → `TIMESTAMP_NS`               | `Timestamp<NANOSECOND> (unit=3)`       | number `1709214312123.4568` (unsafe) | number `1709214312123.4568` (unsafe) | `1709214312123.4568`                    | `1709214312123.4568`                    | `1709214312123.4568`     | `2024-02-29T13:45:12.123Z`             | temporal    | `1709214312123.4568`                 |
| 12  | `TIMESTAMPTZ` → `TIMESTAMP WITH TIME ZONE`    | `Timestamp<MICROSECOND, UTC> (unit=2)` | number `1709194512123.456` (unsafe)  | number `1709194512123.456` (unsafe)  | `1709194512123.456`                     | `1709194512123.456`                     | `1709194512123.456`      | `2024-02-29T08:15:12.123Z`             | temporal    | `1709194512123.456`                  |
| 13  | `TIME` → `TIME`                               | `Time64<MICROSECOND> (unit=2)`         | bigint `49512123456`                 | bigint `49512123456`                 | `49512123456`                           | `49512123456`                           | `49512123456`            | `13:45:12.123456`                      | temporal    | `49512123456`                        |
| 14  | `TIME WITH TIME ZONE` → `TIME WITH TIME ZONE` | `Time64<MICROSECOND> (unit=2)`         | bigint `49512123456`                 | NOT PROBED                           | `49512123456`                           | `49512123456`                           | `49512123456`            | `13:45:12.123456`                      | temporal    | `49512123456`                        |
| 15  | `INTERVAL` → `INTERVAL`                       | `Interval<MONTH_DAY_NANO> (unit=2)`    | object (Int32Array)                  | object (Int32Array)                  | `<8 bytes>`                             | `<8 bytes>`                             | `<8 bytes>`              | ``                                     | text        | `<8 bytes>`                          |
| 16  | `BIGINT` → `BIGINT`                           | `Int64`                                | bigint `9007199254740993`            | bigint `9007199254740993`            | `9007199254740993`                      | `9007199254740993`                      | `9007199254740993`       | `9007199254740993`                     | number      | `9007199254740993`                   |
| 17  | `UBIGINT` → `UBIGINT`                         | `Uint64`                               | bigint `18446744073709551615`        | bigint `18446744073709551615`        | `18446744073709551615`                  | `18446744073709551615`                  | `18446744073709551615`   | `18446744073709551615`                 | number      | `18446744073709551615`               |
| 18  | `DECIMAL(18,6)` → `DECIMAL(18,6)`             | `Decimal[18e+6]`                       | object (DecimalBigNum)               | object (DecimalBigNum)               | `1700000000.123456`                     | `1700000000.123456`                     | `<16 bytes>`             | ``                                     | number      | `1700000000.123456`                  |
| 19  | `DOUBLE` → `DOUBLE`                           | `Float64`                              | number `1709251200.5` (unsafe)       | number `1709251200.5` (unsafe)       | `1709251200.5`                          | `1709251200.5`                          | `1709251200.5`           | `1709251200.5`                         | number      | `1709251200.5`                       |
| 20  | `VARCHAR` → `VARCHAR`                         | `Utf8`                                 | string `2024-02-29 13:45:12`         | string `2024-02-29 13:45:12`         | `2024-02-29 13:45:12`                   | `2024-02-29 13:45:12`                   | `2024-02-29 13:45:12`    | `2024-02-29 13:45:12`                  | text        | `"2024-02-29 13:45:12"`              |
| 21  | `BOOLEAN` → `BOOLEAN`                         | `Bool`                                 | boolean `true`                       | boolean `true`                       | `true`                                  | `true`                                  | `true`                   | `true`                                 | boolean     | `true`                               |
| 22  | `TIMESTAMP NULL` → `TIMESTAMP`                | `Timestamp<MICROSECOND> (unit=2)`      | `null`                               | `null`                               | ``                                      | `null`                                  | ``                       | ``                                     | temporal    | `null`                               |

### Live-query path (`client.query`, no parquet round-trip): full expression set

| expression      | DuckDB type                            | Arrow field type + unit                                                     | delivered cell                                                          | grid scalar                                    | SQL cell (untyped)                             | focused copy                                   | editor draft               | editor kind | nested preview                                                                                                                            |
| --------------- | -------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------- | ---------------------------------------------- | -------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `d_neg`         | `DATE`                                 | `Date32<DAY>`                                                               | number `-86400000`                                                      | `-86400000`                                    | `-86400000`                                    | `-86400000`                                    | `1969-12-31`               | temporal    | `-86400000`                                                                                                                               |
| `d_epoch`       | `DATE`                                 | `Date32<DAY>`                                                               | number `0`                                                              | `0`                                            | `0`                                            | `0`                                            | `1970-01-01`               | temporal    | `0`                                                                                                                                       |
| `d_leap`        | `DATE`                                 | `Date32<DAY>`                                                               | number `1709164800000`                                                  | `1709164800000`                                | `1709164800000`                                | `1709164800000`                                | `2024-02-29`               | temporal    | `1709164800000`                                                                                                                           |
| `d_9999`        | `DATE`                                 | `Date32<DAY>`                                                               | number `253402214400000`                                                | `253402214400000`                              | `253402214400000`                              | `253402214400000`                              | `9999-12-31`               | temporal    | `253402214400000`                                                                                                                         |
| `d_far`         | `DATE`                                 | `Date32<DAY>`                                                               | number `8640009504000000`                                               | `8640009504000000`                             | `8640009504000000`                             | `8640009504000000`                             | `8640009504000000`         | temporal    | `8640009504000000`                                                                                                                        |
| `d_inf`         | `DATE`                                 | `Date32<DAY>`                                                               | number `185542587100800000` (unsafe)                                    | `185542587100800000`                           | `185542587100800000`                           | `185542587100800000`                           | `185542587100800000`       | temporal    | `185542587100800000`                                                                                                                      |
| `d_neg_inf`     | `DATE`                                 | `Date32<DAY>`                                                               | number `-185542587100800000` (unsafe)                                   | `-185542587100800000`                          | `-185542587100800000`                          | `-185542587100800000`                          | `-185542587100800000`      | temporal    | `-185542587100800000`                                                                                                                     |
| `ts_neg`        | `TIMESTAMP`                            | `Timestamp<MICROSECOND>`                                                    | number `-0.001` (unsafe)                                                | `-0.001`                                       | `-0.001`                                       | `-0.001`                                       | `1970-01-01T00:00:00.000Z` | temporal    | `-0.001`                                                                                                                                  |
| `ts_midnight`   | `TIMESTAMP`                            | `Timestamp<MICROSECOND>`                                                    | number `1709164800000`                                                  | `1709164800000`                                | `1709164800000`                                | `1709164800000`                                | `2024-02-29T00:00:00.000Z` | temporal    | `1709164800000`                                                                                                                           |
| `ts_frac`       | `TIMESTAMP`                            | `Timestamp<MICROSECOND>`                                                    | number `1709214312123.456` (unsafe)                                     | `1709214312123.456`                            | `1709214312123.456`                            | `1709214312123.456`                            | `2024-02-29T13:45:12.123Z` | temporal    | `1709214312123.456`                                                                                                                       |
| `ts_ms_only`    | `TIMESTAMP`                            | `Timestamp<MICROSECOND>`                                                    | number `1709214312123`                                                  | `1709214312123`                                | `1709214312123`                                | `1709214312123`                                | `2024-02-29T13:45:12.123Z` | temporal    | `1709214312123`                                                                                                                           |
| `ts_inf`        | `TIMESTAMP`                            | `Timestamp<MICROSECOND>`                                                    | **`get()` THREW**: 9223372036854775 is not safe to convert to a number. | ``                                             | ``                                             | `null`                                         | ``                         | temporal    | `undefined`                                                                                                                               |
| `ts_s`          | `TIMESTAMP_S`                          | `Timestamp<SECOND>`                                                         | number `1709214312000`                                                  | `1709214312000`                                | `1709214312000`                                | `1709214312000`                                | `2024-02-29T13:45:12.000Z` | temporal    | `1709214312000`                                                                                                                           |
| `ts_ms`         | `TIMESTAMP_MS`                         | `Timestamp<MILLISECOND>`                                                    | number `1709214312123`                                                  | `1709214312123`                                | `1709214312123`                                | `1709214312123`                                | `2024-02-29T13:45:12.123Z` | temporal    | `1709214312123`                                                                                                                           |
| `ts_ns`         | `TIMESTAMP_NS`                         | `Timestamp<NANOSECOND>`                                                     | number `1709214312123.4568` (unsafe)                                    | `1709214312123.4568`                           | `1709214312123.4568`                           | `1709214312123.4568`                           | `2024-02-29T13:45:12.123Z` | temporal    | `1709214312123.4568`                                                                                                                      |
| `ts_ns_neg`     | `TIMESTAMP_NS`                         | `Timestamp<NANOSECOND>`                                                     | number `-0.000001` (unsafe)                                             | `-0.000001`                                    | `-0.000001`                                    | `-0.000001`                                    | `1970-01-01T00:00:00.000Z` | temporal    | `-0.000001`                                                                                                                               |
| `ts_far`        | `TIMESTAMP`                            | `Timestamp<MICROSECOND>`                                                    | number `8640009504000000`                                               | `8640009504000000`                             | `8640009504000000`                             | `8640009504000000`                             | `8640009504000000`         | temporal    | `8640009504000000`                                                                                                                        |
| `tstz_offset`   | `TIMESTAMP WITH TIME ZONE`             | `Timestamp<MICROSECOND, UTC>`                                               | number `1709194512123.456` (unsafe)                                     | `1709194512123.456`                            | `1709194512123.456`                            | `1709194512123.456`                            | `2024-02-29T08:15:12.123Z` | temporal    | `1709194512123.456`                                                                                                                       |
| `tstz_utc`      | `TIMESTAMP WITH TIME ZONE`             | `Timestamp<MICROSECOND, UTC>`                                               | number `1709194512123.456` (unsafe)                                     | `1709194512123.456`                            | `1709194512123.456`                            | `1709194512123.456`                            | `2024-02-29T08:15:12.123Z` | temporal    | `1709194512123.456`                                                                                                                       |
| `tstz_other_tz` | —                                      | —                                                                           | **PROBE FAILED**                                                        | —                                              | —                                              | —                                              | —                          | —           | `Failed to execute 'send' on 'XMLHttpRequest': Failed to load 'https://extensions.duckdb.org/v1.4.3/wasm_mvp/icu.duckdb_extension.wasm'.` |
| `t_frac`        | `TIME`                                 | `Time64<MICROSECOND>`                                                       | bigint `49512123456`                                                    | `49512123456`                                  | `49512123456`                                  | `49512123456`                                  | `13:45:12.123456`          | temporal    | `49512123456`                                                                                                                             |
| `t_midnight`    | `TIME`                                 | `Time64<MICROSECOND>`                                                       | bigint `0`                                                              | `0`                                            | `0`                                            | `0`                                            | `00:00:00`                 | temporal    | `0`                                                                                                                                       |
| `t_lastmicro`   | `TIME`                                 | `Time64<MICROSECOND>`                                                       | bigint `86399999999`                                                    | `86399999999`                                  | `86399999999`                                  | `86399999999`                                  | `23:59:59.999999`          | temporal    | `86399999999`                                                                                                                             |
| `t_half`        | `TIME`                                 | `Time64<MICROSECOND>`                                                       | bigint `500000`                                                         | `500000`                                       | `500000`                                       | `500000`                                       | `00:00:00.500000`          | temporal    | `500000`                                                                                                                                  |
| `timetz`        | `TIME WITH TIME ZONE`                  | `Time64<MICROSECOND>`                                                       | bigint `49512123456`                                                    | `49512123456`                                  | `49512123456`                                  | `49512123456`                                  | `13:45:12.123456`          | temporal    | `49512123456`                                                                                                                             |
| `iv`            | `INTERVAL`                             | `Interval<MONTH_DAY_NANO>`                                                  | object (Int32Array)                                                     | `<8 bytes>`                                    | `<8 bytes>`                                    | `<8 bytes>`                                    | ``                         | text        | `<8 bytes>`                                                                                                                               |
| `iv_frac`       | `INTERVAL`                             | `Interval<MONTH_DAY_NANO>`                                                  | object (Int32Array)                                                     | `<8 bytes>`                                    | `<8 bytes>`                                    | `<8 bytes>`                                    | ``                         | text        | `<8 bytes>`                                                                                                                               |
| `bi_epoch`      | `BIGINT`                               | `Int64`                                                                     | bigint `1700000000000`                                                  | `1700000000000`                                | `1700000000000`                                | `1700000000000`                                | `1700000000000`            | number      | `1700000000000`                                                                                                                           |
| `bi_unsafe`     | `BIGINT`                               | `Int64`                                                                     | bigint `9007199254740993`                                               | `9007199254740993`                             | `9007199254740993`                             | `9007199254740993`                             | `9007199254740993`         | number      | `9007199254740993`                                                                                                                        |
| `ubi_max`       | `UBIGINT`                              | `Uint64`                                                                    | bigint `18446744073709551615`                                           | `18446744073709551615`                         | `18446744073709551615`                         | `18446744073709551615`                         | `18446744073709551615`     | number      | `18446744073709551615`                                                                                                                    |
| `dec_epoch`     | `DECIMAL(18,6)`                        | `Decimal[18e+6]`                                                            | object (DecimalBigNum)                                                  | `1700000000.123456`                            | `<16 bytes>`                                   | `1700000000.123456`                            | ``                         | number      | `1700000000.123456`                                                                                                                       |
| `dec_wide`      | `DECIMAL(38,0)`                        | `Decimal[38e0]`                                                             | object (DecimalBigNum)                                                  | `123456789012345678`                           | `<16 bytes>`                                   | `123456789012345678`                           | ``                         | number      | `123456789012345678`                                                                                                                      |
| `hi_epoch`      | `HUGEINT`                              | `Decimal[38e0]`                                                             | object (DecimalBigNum)                                                  | `1700000000000000000`                          | `<16 bytes>`                                   | `1700000000000000000`                          | ``                         | number      | `1700000000000000000`                                                                                                                     |
| `dbl_epoch`     | `DOUBLE`                               | `Float64`                                                                   | number `1709251200.5` (unsafe)                                          | `1709251200.5`                                 | `1709251200.5`                                 | `1709251200.5`                                 | `1709251200.5`             | number      | `1709251200.5`                                                                                                                            |
| `dbl_inf`       | `DOUBLE`                               | `Float64`                                                                   | number `Infinity` (unsafe)                                              | `Infinity`                                     | `Infinity`                                     | `Infinity`                                     | `Infinity`                 | number      | `Infinity`                                                                                                                                |
| `i32_epoch`     | `INTEGER`                              | `Int32`                                                                     | number `42`                                                             | `42`                                           | `42`                                           | `42`                                           | `42`                       | number      | `42`                                                                                                                                      |
| `s_temporal`    | `VARCHAR`                              | `Utf8`                                                                      | string `2024-02-29 13:45:12`                                            | `2024-02-29 13:45:12`                          | `2024-02-29 13:45:12`                          | `2024-02-29 13:45:12`                          | `2024-02-29 13:45:12`      | text        | `"2024-02-29 13:45:12"`                                                                                                                   |
| `s_text`        | `VARCHAR`                              | `Utf8`                                                                      | string `about: 2024-02-29`                                              | `about: 2024-02-29`                            | `about: 2024-02-29`                            | `about: 2024-02-29`                            | `about: 2024-02-29`        | text        | `"about: 2024-02-29"`                                                                                                                     |
| `b_true`        | `BOOLEAN`                              | `Bool`                                                                      | boolean `true`                                                          | `true`                                         | `true`                                         | `true`                                         | `true`                     | boolean     | `true`                                                                                                                                    |
| `ts_null`       | `TIMESTAMP`                            | `Timestamp<MICROSECOND>`                                                    | `null`                                                                  | ``                                             | ``                                             | `null`                                         | ``                         | temporal    | `null`                                                                                                                                    |
| `d_null`        | `DATE`                                 | `Date32<DAY>`                                                               | `null`                                                                  | ``                                             | ``                                             | `null`                                         | ``                         | temporal    | `null`                                                                                                                                    |
| `t_null`        | `TIME`                                 | `Time64<MICROSECOND>`                                                       | `null`                                                                  | ``                                             | ``                                             | `null`                                         | ``                         | temporal    | `null`                                                                                                                                    |
| `nested`        | `STRUCT(ts TIMESTAMP, d DATE, t TIME)` | `Struct<{ts:Timestamp<MICROSECOND>, d:Date32<DAY>, t:Time64<MICROSECOND>}>` | object (StructRow)                                                      | `{"ts":1709164800000,"d":1709164800000,"t":0}` | `{"ts":1709164800000,"d":1709164800000,"t":0}` | `{"ts":1709164800000,"d":1709164800000,"t":0}` | ``                         | unsupported | `{"ts":1709164800000,"d":1709164800000,"t":0}`                                                                                            |
| `dates_list`    | `DATE[]`                               | `List<Date32<DAY>>`                                                         | object (Vector)                                                         | `[1709164800000,-86400000]`                    | `[1709164800000,-86400000]`                    | `[1709164800000,-86400000]`                    | ``                         | unsupported | `[1709164800000,-86400000]`                                                                                                               |

### Precision recovery check (engine canonical text vs delivered float)

| column  | DuckDB canonical text (`CAST(col AS VARCHAR)` from the engine) | delivered value                      | `delivered*1000`        | integer? | `Math.round(delivered*1000)` |
| ------- | -------------------------------------------------------------- | ------------------------------------ | ----------------------- | -------- | ---------------------------- |
| d_neg   | `1969-12-31`                                                   | number `-86400000`                   | `-86400000000`          | true     | `-86400000000`               |
| d_leap  | `2024-02-29`                                                   | number `1709164800000`               | `1709164800000000`      | true     | `1709164800000000`           |
| d_far   | `275761-01-01`                                                 | number `8640009504000000`            | `8640009504000000000`   | true     | `8640009504000000000`        |
| d_inf   | `infinity`                                                     | number `185542587100800000` (unsafe) | `185542587100800000000` | true     | `185542587100800000000`      |
| ts_neg  | `1969-12-31 23:59:59.999999`                                   | number `-0.001` (unsafe)             | `-1`                    | true     | `-1`                         |
| ts_leap | `2024-02-29 00:00:00`                                          | number `1709164800000`               | `1709164800000000`      | true     | `1709164800000000`           |
| ts_frac | `2024-02-29 13:45:12.123456`                                   | number `1709214312123.456` (unsafe)  | `1709214312123456`      | true     | `1709214312123456`           |
| ts_s    | `2024-02-29 13:45:12`                                          | number `1709214312000`               | `1709214312000000`      | true     | `1709214312000000`           |
| ts_ms   | `2024-02-29 13:45:12.123`                                      | number `1709214312123`               | `1709214312123000`      | true     | `1709214312123000`           |
| ts_ns   | `2024-02-29 13:45:12.123456789`                                | number `1709214312123.4568` (unsafe) | `1709214312123456.8`    | false    | `1709214312123457`           |
| tstz    | `2024-02-29 08:15:12.123456+00`                                | number `1709194512123.456` (unsafe)  | `1709194512123456`      | true     | `1709194512123456`           |
| t       | `13:45:12.123456`                                              | bigint `49512123456`                 | `49512123456`           | —        | `—`                          |

### Alias acceptance (`parseDuckDbType` + `cellEditorKind`) observed in the browser at the pinned SHA

| type string                | parsed kind | parsed label               | editor kind | `cellEditDraft(1709164800000, parsed)` | `cellEditDraft(49512123456n, parsed)` |
| -------------------------- | ----------- | -------------------------- | ----------- | -------------------------------------- | ------------------------------------- |
| `DATE`                     | primitive   | `DATE`                     | temporal    | `2024-02-29`                           | `1971-07-28`                          |
| `TIMESTAMP`                | primitive   | `TIMESTAMP`                | temporal    | `2024-02-29T00:00:00.000Z`             | `1971-07-28T01:22:03.456Z`            |
| `TIMESTAMP_S`              | primitive   | `TIMESTAMP_S`              | temporal    | `2024-02-29T00:00:00.000Z`             | `1971-07-28T01:22:03.456Z`            |
| `TIMESTAMP_MS`             | primitive   | `TIMESTAMP_MS`             | temporal    | `2024-02-29T00:00:00.000Z`             | `1971-07-28T01:22:03.456Z`            |
| `TIMESTAMP_NS`             | primitive   | `TIMESTAMP_NS`             | temporal    | `2024-02-29T00:00:00.000Z`             | `1971-07-28T01:22:03.456Z`            |
| `TIMESTAMPTZ`              | primitive   | `TIMESTAMPTZ`              | temporal    | `2024-02-29T00:00:00.000Z`             | `1971-07-28T01:22:03.456Z`            |
| `TIMESTAMP WITH TIME ZONE` | primitive   | `TIMESTAMP WITH TIME ZONE` | temporal    | `2024-02-29T00:00:00.000Z`             | `1971-07-28T01:22:03.456Z`            |
| `TIME`                     | primitive   | `TIME`                     | temporal    | `474:46:04.800000`                     | `13:45:12.123456`                     |
| `TIMETZ`                   | primitive   | `TIMETZ`                   | text        | `1709164800000`                        | `49512123456`                         |
| `TIME WITH TIME ZONE`      | primitive   | `TIME WITH TIME ZONE`      | temporal    | `474:46:04.800000`                     | `13:45:12.123456`                     |
| `INTERVAL`                 | primitive   | `INTERVAL`                 | text        | `1709164800000`                        | `49512123456`                         |
| `DATETIME`                 | primitive   | `DATETIME`                 | text        | `1709164800000`                        | `49512123456`                         |
| `date`                     | primitive   | `date`                     | temporal    | `2024-02-29`                           | `1971-07-28`                          |
| `timestamp`                | primitive   | `timestamp`                | temporal    | `2024-02-29T00:00:00.000Z`             | `1971-07-28T01:22:03.456Z`            |
| `timestamp with time zone` | primitive   | `timestamp with time zone` | temporal    | `2024-02-29T00:00:00.000Z`             | `1971-07-28T01:22:03.456Z`            |
| `time with time zone`      | primitive   | `time with time zone`      | temporal    | `474:46:04.800000`                     | `13:45:12.123456`                     |
| `DECIMAL(18,6)`            | primitive   | `DECIMAL(18,6)`            | number      | `1709164800000`                        | `49512123456`                         |
| `BIGINT`                   | primitive   | `BIGINT`                   | number      | `1709164800000`                        | `49512123456`                         |
| `UBIGINT`                  | primitive   | `UBIGINT`                  | number      | `1709164800000`                        | `49512123456`                         |
| `HUGEINT`                  | primitive   | `HUGEINT`                  | number      | `1709164800000`                        | `49512123456`                         |

### App-level projection survival

```json
{
  "baseProjectBatchToRows": {
    "ok": false,
    "error": {
      "name": "TypeError",
      "message": "9223372036854775 is not safe to convert to a number.",
      "stack": "TypeError: 9223372036854775 is not safe to convert to a number. |     at bigIntToNumber (http://localhost:4199/@fs/tmp/assay-wf01p/packages/engine-duckdb/node_modules/.vite/deps/Arrow.dom-BBVZAafn.js?v=2588362f:3274:114) |     at divideBigInts (http://localhost:4199/@fs/tmp/assay-wf01p/packages/engine-duckdb/node_modules/.vite/deps/Arrow.dom-BBVZAafn.js?v=2588362f:3287:9) |     at getTimestampMicrosecond (http://localhost:4199/@fs/tmp/assay-wf01p/packages/engine-duckdb/node_modules/.vite/deps/Arrow.dom-BBVZAafn.js?v=2588362f:5057:54) |     at getTimestamp (http://localhost:4199/@fs/tmp/assay-wf01p/packages/engine-duckdb/node_modules/.vite/deps/Arrow.dom-BBVZAafn.js?v=2588362f:5066:37) |     at http://localhost:4199/@fs/tmp/assay-wf01p/packages/engine-duckdb/node_modules/.vite/deps/Arrow.dom-BBVZAafn.js?v=2588362f:5007:43"
    }
  },
  "overlayProjectOverlayPage": {
    "ok": false,
    "error": {
      "name": "TypeError",
      "message": "9223372036854775 is not safe to convert to a number.",
      "stack": "TypeError: 9223372036854775 is not safe to convert to a number. |     at bigIntToNumber (http://localhost:4199/@fs/tmp/assay-wf01p/packages/engine-duckdb/node_modules/.vite/deps/Arrow.dom-BBVZAafn.js?v=2588362f:3274:114) |     at divideBigInts (http://localhost:4199/@fs/tmp/assay-wf01p/packages/engine-duckdb/node_modules/.vite/deps/Arrow.dom-BBVZAafn.js?v=2588362f:3287:9) |     at getTimestampMicrosecond (http://localhost:4199/@fs/tmp/assay-wf01p/packages/engine-duckdb/node_modules/.vite/deps/Arrow.dom-BBVZAafn.js?v=2588362f:5057:54) |     at getTimestamp (http://localhost:4199/@fs/tmp/assay-wf01p/packages/engine-duckdb/node_modules/.vite/deps/Arrow.dom-BBVZAafn.js?v=2588362f:5066:37) |     at http://localhost:4199/@fs/tmp/assay-wf01p/packages/engine-duckdb/node_modules/.vite/deps/Arrow.dom-BBVZAafn.js?v=2588362f:5007:43"
    }
  }
}
```

### Profile (engine-side) temporal text

```json
{
  "rowCount": 2,
  "columns": [
    {
      "name": "d_neg",
      "type": "DATE",
      "kind": "categorical",
      "nullCount": 1,
      "distinctCount": 1,
      "categorical": {
        "topK": [
          {
            "value": "1969-12-31",
            "count": 1
          }
        ]
      }
    },
    {
      "name": "d_leap",
      "type": "DATE",
      "kind": "categorical",
      "nullCount": 1,
      "distinctCount": 1,
      "categorical": {
        "topK": [
          {
            "value": "2024-02-29",
            "count": 1
          }
        ]
      }
    },
    {
      "name": "d_epoch",
      "type": "DATE",
      "kind": "categorical",
      "nullCount": 1,
      "distinctCount": 1,
      "categorical": {
        "topK": [
          {
            "value": "1970-01-01",
            "count": 1
          }
        ]
      }
    },
    {
      "name": "d_far",
      "type": "DATE",
      "kind": "categorical",
      "nullCount": 1,
      "distinctCount": 1,
      "categorical": {
        "topK": [
          {
            "value": "275761-01-01",
            "count": 1
          }
        ]
      }
    },
    {
      "name": "d_inf",
      "type": "DATE",
      "kind": "categorical",
      "nullCount": 1,
      "distinctCount": 1,
      "categorical": {
        "topK": [
          {
            "value": "infinity",
            "count": 1
          }
        ]
      }
    },
    {
      "name": "ts_neg",
      "type": "TIMESTAMP",
      "kind": "categorical",
      "nullCount": 1,
      "distinctCount": 1,
      "categorical": {
        "topK": [
          {
            "value": "1969-12-31 23:59:59.999999",
            "count": 1
          }
        ]
      }
    },
    {
      "name": "ts_leap",
      "type": "TIMESTAMP",
      "kind": "categorical",
      "nullCount": 1,
      "distinctCount": 1,
      "categorical": {
        "topK": [
          {
            "value": "2024-02-29 00:00:00",
            "count": 1
          }
        ]
      }
    },
    {
      "name": "ts_frac",
      "type": "TIMESTAMP",
      "kind": "categorical",
      "nullCount": 1,
      "distinctCount": 1,
      "categorical": {
        "topK": [
          {
            "value": "2024-02-29 13:45:12.123456",
            "count": 1
          }
        ]
      }
    },
    {
      "name": "ts_inf",
      "type": "TIMESTAMP",
      "kind": "categorical",
      "nullCount": 1,
      "distinctCount": 1,
      "categorical": {
        "topK": [
          {
            "value": "infinity",
            "count": 1
          }
        ]
      }
    },
    {
      "name": "ts_s",
      "type": "TIMESTAMP",
      "kind": "categorical",
      "nullCount": 1,
      "distinctCount": 1,
      "categorical": {
        "topK": [
          {
            "value": "2024-02-29 13:45:12",
            "count": 1
          }
        ]
      }
    },
    {
      "name": "ts_ms",
      "type": "TIMESTAMP",
      "kind": "categorical",
      "nullCount": 1,
      "distinctCount": 1,
      "categorical": {
        "topK": [
          {
            "value": "2024-02-29 13:45:12.123",
            "count": 1
          }
        ]
      }
    },
    {
      "name": "ts_ns",
      "type": "TIMESTAMP_NS",
      "kind": "categorical",
      "nullCount": 1,
      "distinctCount": 1,
      "categorical": {
        "topK": [
          {
            "value": "2024-02-29 13:45:12.123456789",
            "count": 1
          }
        ]
      }
    },
    {
      "name": "tstz",
      "type": "TIMESTAMP WITH TIME ZONE",
      "kind": "categorical",
      "nullCount": 1,
      "distinctCount": 1,
      "categorical": {
        "topK": [
          {
            "value": "2024-02-29 08:15:12.123456+00",
            "count": 1
          }
        ]
      }
    },
    {
      "name": "t",
      "type": "TIME",
      "kind": "categorical",
      "nullCount": 1,
      "distinctCount": 1,
      "categorical": {
        "topK": [
          {
            "value": "13:45:12.123456",
            "count": 1
          }
        ]
      }
    },
    {
      "name": "iv",
      "type": "INTERVAL",
      "kind": "other",
      "nullCount": 1,
      "distinctCount": 1
    },
    {
      "name": "bi",
      "type": "BIGINT",
      "kind": "numeric",
      "nullCount": 1,
      "distinctCount": 1,
      "numeric": {
        "min": 1700000000000,
        "max": 1700000000000,
        "mean": 1700000000000,
        "stddev": null,
        "quantiles": {
          "p50": 1700000000000,
          "p90": 1700000000000,
          "p95": 1700000000000,
          "p99": 1700000000000
        }
      }
    },
    {
      "name": "bi_unsafe",
      "type": "BIGINT",
      "kind": "numeric",
      "nullCount": 1,
      "distinctCount": 1,
      "numeric": {
        "min": 9007199254740992,
        "max": 9007199254740992,
        "mean": 9007199254740992,
        "stddev": null,
        "quantiles": {
          "p50": 9007199254740992,
          "p90": 9007199254740992,
          "p95": 9007199254740992,
          "p99": 9007199254740992
        }
      }
    },
    {
      "name": "ubi",
      "type": "UBIGINT",
      "kind": "numeric",
      "nullCount": 1,
      "distinctCount": 1,
      "numeric": {
        "min": 18446744073709552000,
        "max": 18446744073709552000,
        "mean": 18446744073709552000,
        "stddev": null,
        "quantiles": {
          "p50": 18446744073709552000,
          "p90": 18446744073709552000,
          "p95": 18446744073709552000,
          "p99": 18446744073709552000
        }
      }
    },
    {
      "name": "dec_val",
      "type": "DECIMAL(18,6)",
      "kind": "numeric",
      "nullCount": 1,
      "distinctCount": 1,
      "numeric": {
        "min": 1700000000.123456,
        "max": 1700000000.123456,
        "mean": 1700000000.123456,
        "stddev": null,
        "quantiles": {
          "p50": 1700000000.123456,
          "p90": 1700000000.123456,
          "p95": 1700000000.123456,
          "p99": 1700000000.123456
        }
      }
    },
    {
      "name": "hi",
      "type": "DOUBLE",
      "kind": "numeric",
      "nullCount": 1,
      "distinctCount": 1,
      "numeric": {
        "min": 1700000000000000000,
        "max": 1700000000000000000,
        "mean": 1700000000000000000,
        "stddev": null,
        "quantiles": {
          "p50": 1700000000000000000,
          "p90": 1700000000000000000,
          "p95": 1700000000000000000,
          "p99": 1700000000000000000
        }
      }
    },
    {
      "name": "dbl",
      "type": "DOUBLE",
      "kind": "numeric",
      "nullCount": 1,
      "distinctCount": 1,
      "numeric": {
        "min": 1709251200.5,
        "max": 1709251200.5,
        "mean": 1709251200.5,
        "stddev": null,
        "quantiles": {
          "p50": 1709251200.5,
          "p90": 1709251200.5,
          "p95": 1709251200.5,
          "p99": 1709251200.5
        }
      }
    },
    {
      "name": "i32",
      "type": "INTEGER",
      "kind": "numeric",
      "nullCount": 1,
      "distinctCount": 1,
      "numeric": {
        "min": 42,
        "max": 42,
        "mean": 42,
        "stddev": null,
        "quantiles": {
          "p50": 42,
          "p90": 42,
          "p95": 42,
          "p99": 42
        }
      }
    },
    {
      "name": "s",
      "type": "VARCHAR",
      "kind": "categorical",
      "nullCount": 1,
      "distinctCount": 1,
      "categorical": {
        "topK": [
          {
            "value": "2024-02-29 13:45:12",
            "count": 1
          }
        ]
      }
    },
    {
      "name": "b",
      "type": "BOOLEAN",
      "kind": "categorical",
      "nullCount": 1,
      "distinctCount": 1,
      "categorical": {
        "topK": [
          {
            "value": "true",
            "count": 1
          }
        ]
      }
    },
    {
      "name": "ts_null",
      "type": "TIMESTAMP",
      "kind": "categorical",
      "nullCount": 2,
      "distinctCount": 0,
      "categorical": {
        "topK": []
      }
    },
    {
      "name": "nested",
      "type": "STRUCT(ts TIMESTAMP, d DATE, t TIME)",
      "kind": "other",
      "nullCount": 1,
      "distinctCount": 1
    },
    {
      "name": "dates",
      "type": "DATE[]",
      "kind": "other",
      "nullCount": 1,
      "distinctCount": 1
    }
  ]
}
```

---

## 3. Consumer table — is the declared type reachable, and what does each consumer do today?

All call sites read from the pinned source; the "observed output" column is from the probes above.

| Consumer                | Call site (pinned SHA)                                                                                            | Declared DuckDB type available?                                                                                                                                                                                                          | Observed output for `DATE '2024-02-29'` / `TIMESTAMP …13:45:12.123456` / `TIME …13:45:12.123456`                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Grid scalar cell        | `apps/web/src/grid/DataGrid.tsx:1302` → `formatCell(cell, column?.type, parsedType ?? null)`                      | **Yes** — effective-schema type string + the precomputed parsed tree (`parsedColumnTypes`, line 274)                                                                                                                                     | `1709164800000` / `1709214312123.456` / `49512123456` (raw epoch)                                                           |
| Focused display-copy    | `DataGrid.tsx:626` → `composeCellCopyText(value, column?.type, parsedColumnTypes[i] ?? null)` → `formatCell`      | **Yes**                                                                                                                                                                                                                                  | identical to the cell — **grid == copy in 151/151 observed pairs**                                                          |
| Editor draft            | `DataGrid.tsx:422` → `cellEditDraft(cell, parsedType)` → `temporalDraft`                                          | **Yes** (parsed tree; the raw string is not needed)                                                                                                                                                                                      | `2024-02-29` / `2024-02-29T13:45:12.123Z` / `13:45:12.123456` (**already formatted**)                                       |
| Nested grid preview     | `format.ts` → `formatNestedPreview(value, { columnType: parsed })`; `nested-preview.ts:172,261`                   | **Yes** (whole parsed tree incl. child temporal types) — but the temporal formatting is **not** applied                                                                                                                                  | `{"ts":1709164800000,"d":1709164800000,"t":0}`, `[1709164800000,-86400000]`                                                 |
| Record tree             | `record/record-tree.ts` → `buildRecordTree({ columns, cells })` (`RecordRowInput` carries **names + cells only**) | **No** — `RecordRowInput` has no type channel at all                                                                                                                                                                                     | every temporal leaf: `kind: 'leaf'`, `summary: "1709164800000"` / `"1709214312123.456"` / `"49512123456"`                   |
| SQL results             | `sql/SqlPanel.tsx:399` → `formatCell(cell)` — **no type argument**                                                | **No.** The Arrow batch is in scope (`resultColumnNames(result.batch)` reads `batch.schema.fields[i].name`, `paged-query.ts:103`), so Arrow field types are reachable but unused, and the **DuckDB** type string is not available at all | `1709164800000` / `1709214312123.456` / `49512123456` (identical to today's grid)                                           |
| Profile (for reference) | `packages/engine-duckdb/src/profile-query.ts` / `profile-classify.ts`                                             | n/a — engine-side SQL, not Arrow                                                                                                                                                                                                         | **already text**: `2024-02-29`, `2024-02-29 13:45:12.123456`, `13:45:12.123456`, and for NS `2024-02-29 13:45:12.123456789` |

Consequences that matter for the maintainer:

- The **grid, copy and editor already have everything** a type-aware formatter needs. No engine/client/protocol change is required.
- `SqlPanel` has Arrow metadata in scope but no DuckDB type string, so under scope A it would keep showing raw epoch numbers _while the grid starts showing dates_ — a **new visible divergence** that must be stated as a residual, not silently accepted.
- Profile output proves DuckDB itself can render full precision (`…123456789`, `+00`), which the Arrow→JS projection cannot.

---

## 4. Base vs overlay projection differences

Observed with `DuckDbGridProvider` (base fast path) and the same class with a staged overlay (`column-rename` of a text column + a `text`-kind `cell-set` on a temporal column):

| Column kind                                                                                                                                                           | Base path Arrow                                            | Overlay path Arrow                                                  | Base value           | Overlay value                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------- | -------------------- | --------------------------------------------------------------- |
| `DATE`, `TIMESTAMP`, `TIMESTAMP_S/MS/NS`, `TIMESTAMPTZ`, `TIME`, `INTERVAL`, `BIGINT/UBIGINT`, `DECIMAL`, `DOUBLE`, `INTEGER`, `VARCHAR`, `BOOLEAN`, `STRUCT`, `LIST` | `Date32<DAY>` / `Timestamp<…>` / `Time64<MICROSECOND>` / … | **identical** (per-column probe of all 27 columns)                  | number/bigint/object | **identical**                                                   |
| Overlay-edited temporal cell (`ts_frac`, `cell-set` with `{kind:'text', text:'2024-03-01 00:00:00.5'}`)                                                               | —                                                          | `Timestamp<MICROSECOND>`                                            | `1709214312123.456`  | `1709251200500` (the edited value, cast by the engine)          |
| Extra column                                                                                                                                                          | —                                                          | `assay_row_id` (`Utf8`) prepended, stripped by `projectOverlayPage` | —                    | row keys observed: `base:probe-anchor#0`, `base:probe-anchor#1` |

Additional observed facts:

- `overlaySchema()` returns the **renamed** column name (`s_renamed`) with the same type strings, uppercase, exactly like `schema()` — so the declared type is equally available on the overlay path.
- `TIMESTAMP_NS` keeps `Timestamp<NANOSECOND>` through the overlay composition, and `TIMESTAMPTZ` keeps its UTC flag — the overlay SQL passes untouched columns through by reference (`overlay-query.ts:682`), and that is what the wire shows.
- **The one real difference is a failure mode, not a shape**: a window containing `TIMESTAMP 'infinity'` throws in _both_ projections (`projectBatchToRows` **and** `projectOverlayPage`), before any formatter runs.
- Parquet round-trip caveat (observed): `TIMESTAMP_S`/`TIMESTAMP_MS` columns come back declared as `TIMESTAMP` (`Timestamp<MICROSECOND>`), and `HUGEINT` comes back as `DOUBLE`. So in a real opened file the sub-ms unit variants are usually already collapsed; the true unit variants are only reachable through live SQL (`client.query`) or JSONL/CSV sources.

---

## 5. Edge-case evidence (observed values, one line per case)

| Case                                    | Probe                                                                         | Delivered value                                                                                                                            | Grid / copy                                                                                                  | Editor draft                                                                                                                     |
| --------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| pre-1970 DATE                           | `DATE '1969-12-31'`                                                           | `number -86400000`                                                                                                                         | `-86400000`                                                                                                  | `1969-12-31`                                                                                                                     |
| pre-1970 TIMESTAMP (sub-ms)             | `TIMESTAMP '1969-12-31 23:59:59.999999'`                                      | `number -0.001` (**fractional, negative**)                                                                                                 | `-0.001`                                                                                                     | `1970-01-01T00:00:00.000Z` — **wrong: `new Date(-0.001)` snaps to the epoch**                                                    |
| pre-1970 TIMESTAMP_NS                   | `TIMESTAMP_NS '1969-12-31 23:59:59.999999999'`                                | `number -0.000001`                                                                                                                         | `-0.000001`                                                                                                  | `1970-01-01T00:00:00.000Z` (same rounding)                                                                                       |
| pre-1970 negative infinity              | `DATE '-infinity'`                                                            | `number -185542587100800000` (not a safe integer)                                                                                          | raw                                                                                                          | raw (fallback)                                                                                                                   |
| leap day                                | `DATE '2024-02-29'`, `TIMESTAMP '2024-02-29 00:00:00'`                        | `1709164800000` both                                                                                                                       | raw                                                                                                          | `2024-02-29` / `2024-02-29T00:00:00.000Z` (calendar correct)                                                                     |
| epoch                                   | `DATE '1970-01-01'`                                                           | `number 0`                                                                                                                                 | `0`                                                                                                          | `1970-01-01`                                                                                                                     |
| midnight TIME                           | `TIME '00:00:00'`                                                             | `bigint 0`                                                                                                                                 | `0`                                                                                                          | `00:00:00`                                                                                                                       |
| last µs of day                          | `TIME '23:59:59.999999'`                                                      | `bigint 86399999999`                                                                                                                       | raw                                                                                                          | `23:59:59.999999`                                                                                                                |
| sub-second TIME                         | `TIME '00:00:00.5'`                                                           | `bigint 500000`                                                                                                                            | raw                                                                                                          | `00:00:00.500000` (six fixed digits)                                                                                             |
| fractional ms                           | `TIMESTAMP '2024-02-29 13:45:12.123456'`                                      | `number 1709214312123.456`                                                                                                                 | raw                                                                                                          | `2024-02-29T13:45:12.123Z` (**sub-ms dropped**)                                                                                  |
| ns payload                              | `TIMESTAMP_NS '…12.123456789'`                                                | `number 1709214312123.4568`                                                                                                                | raw                                                                                                          | `2024-02-29T13:45:12.123Z` (**ns dropped; value already lossy**)                                                                 |
| NULL                                    | `NULL::TIMESTAMP` / `NULL::DATE` / `NULL::TIME`                               | `null`                                                                                                                                     | `''`                                                                                                         | `''` (`validateCellInput` then rejects the empty draft with the NULL guidance message — existing behaviour)                      |
| naive vs zoned, same instant            | `TIMESTAMP` vs `TIMESTAMPTZ '2024-02-29 13:45:12.123456+05:30'`               | `Timestamp<MICROSECOND>` **no tz** vs `Timestamp<MICROSECOND, UTC>`; both deliver a plain `number` (`1709194512123.456` for the zoned one) | identical raw rendering — **the values are indistinguishable; only the declared type string separates them** | `…08:15:12.123Z` (UTC)                                                                                                           |
| offset normalization                    | `TIMESTAMPTZ '…13:45:12.123456+05:30'` vs `TIMESTAMPTZ '…08:15:12.123456+00'` | **both `1709194512123.456`**                                                                                                               | identical                                                                                                    | identical → **the original offset is unrecoverable**                                                                             |
| TIME WITH TIME ZONE                     | `TIMETZ '13:45:12.123456+05:30'`                                              | `bigint 49512123456` — **identical to plain `TIME '13:45:12.123456'`**; Arrow type has **no** tz                                           | raw                                                                                                          | `13:45:12.123456` → **offset unrecoverable**                                                                                     |
| infinite TIMESTAMP                      | `TIMESTAMP 'infinity'`                                                        | **`get()` throws** `TypeError: 9223372036854775 is not safe to convert to a number.`                                                       | `''` (would never render — the projection throws first)                                                      | `''`                                                                                                                             |
| infinite DATE                           | `DATE 'infinity'`                                                             | `number 185542587100800000` (outside ±8.64e15 = JS Date range)                                                                             | raw                                                                                                          | raw (fallback)                                                                                                                   |
| out-of-JS-range DATE                    | `DATE '275761-01-01'`                                                         | `number 8640009504000000` (> 8.64e15)                                                                                                      | raw                                                                                                          | raw (fallback — observed, the editor already declines to format it)                                                              |
| out-of-JS-range TIMESTAMP               | `TIMESTAMP '275761-01-01 00:00:00'`                                           | `number 8640009504000000`                                                                                                                  | raw                                                                                                          | raw                                                                                                                              |
| very large but in-range DATE            | `DATE '9999-12-31'`                                                           | `number 253402214400000`                                                                                                                   | raw                                                                                                          | `9999-12-31`                                                                                                                     |
| non-finite ordinary number              | `'Infinity'::DOUBLE`                                                          | `number Infinity`                                                                                                                          | `Infinity`                                                                                                   | `Infinity` (rejected on commit: "That is not a number.")                                                                         |
| wide integer that _looks_ like an epoch | `1700000000000::BIGINT`                                                       | `bigint 1700000000000`                                                                                                                     | `1700000000000`                                                                                              | `1700000000000`, `editorKind: number`                                                                                            |
| unsafe wide integer                     | `9007199254740993::BIGINT`                                                    | `bigint 9007199254740993` (**exact**)                                                                                                      | exact                                                                                                        | exact                                                                                                                            |
| unsigned 64-bit max                     | `18446744073709551615::UBIGINT`                                               | `bigint 18446744073709551615`                                                                                                              | exact                                                                                                        | exact                                                                                                                            |
| DECIMAL that looks like an epoch        | `1700000000.123456::DECIMAL(18,6)`                                            | `DecimalBigNum` view                                                                                                                       | `1700000000.123456` **only with the declared type**; `<16 bytes>` without                                    | `''`                                                                                                                             |
| HUGEINT                                 | `1700000000000000000::HUGEINT`                                                | `DecimalBigNum` (Arrow `Decimal[38e0]`)                                                                                                    | `1700000000000000000` (typed) / `<16 bytes>` (untyped)                                                       | `''`                                                                                                                             |
| INTERVAL                                | `INTERVAL '1 day 02:03:04'`                                                   | `Int32Array`-like (8 bytes)                                                                                                                | `<8 bytes>`                                                                                                  | `''`                                                                                                                             |
| temporal-looking VARCHAR                | `'2024-02-29 13:45:12'::VARCHAR`                                              | `string`                                                                                                                                   | unchanged                                                                                                    | unchanged                                                                                                                        |
| wrong-family dispatch                   | `cellEditDraft(1709164800000, DATE-as-TIME)`                                  | —                                                                                                                                          | —                                                                                                            | `474:46:04.800000` (**impossible hours**) — proof that the family must come from the declared type, never from the numeric shape |

**Wide integers vs temporal (the decisive contrast):** `BIGINT 1700000000000` and `DATE '2024-02-29'` are the _same_ JS shape (`number`, integral, in the 1e12 ms band) and the _same_ printed digits class as a TIMESTAMP epoch. They are distinguished **only** by the declared type string (`BIGINT` vs `DATE`/`TIMESTAMP`). Any "number ⇒ format as date" branch would corrupt the BIGINT case; any "truncate to ms" branch would corrupt the µs/ns cases below.

---

## 6. Precision recovery (engine canonical text vs what arrives)

`CAST(col AS VARCHAR)` was executed **in the same engine/session** over the same table, so both sides are DuckDB's own view of one value.

| column                   | DuckDB canonical text           | delivered            | `delivered*1000`        | integral? | `Math.round(delivered*1000)`                                                                    |
| ------------------------ | ------------------------------- | -------------------- | ----------------------- | --------- | ----------------------------------------------------------------------------------------------- |
| `d_leap` (`DATE`)        | `2024-02-29`                    | `1709164800000`      | `1709164800000000`      | yes       | `1709164800000000`                                                                              |
| `d_far` (`DATE`)         | `275761-01-01`                  | `8640009504000000`   | `8640009504000000000`   | yes       | `8640009504000000000`                                                                           |
| `d_inf` (`DATE`)         | `infinity`                      | `185542587100800000` | `185542587100800000000` | yes       | `185542587100800000000`                                                                         |
| `ts_neg` (`TIMESTAMP`)   | `1969-12-31 23:59:59.999999`    | `-0.001`             | `-1`                    | yes       | `-1`                                                                                            |
| `ts_frac` (`TIMESTAMP`)  | `2024-02-29 13:45:12.123456`    | `1709214312123.456`  | `1709214312123456`      | yes       | `1709214312123456` (**exact µs recovered**)                                                     |
| `ts_ns` (`TIMESTAMP_NS`) | `2024-02-29 13:45:12.123456789` | `1709214312123.4568` | `1709214312123456.8`    | **no**    | `1709214312123457` (**≠ canonical µs …456.789 — ns already lost, and rounding lands 1 µs off**) |
| `tstz` (`TIMESTAMPTZ`)   | `2024-02-29 08:15:12.123456+00` | `1709194512123.456`  | `1709194512123456`      | yes       | `1709194512123456`                                                                              |
| `t` (`TIME`)             | `13:45:12.123456`               | `bigint 49512123456` | µs as delivered         | —         | exact                                                                                           |

So: **µs is recoverable from the delivered float for `TIMESTAMP`/`TIMESTAMPTZ` in this range, but not for `TIMESTAMP_NS`; `Date`-based formatting truncates to ms.**

---

## 7. Proposed scope-A contract (for approval, not implemented here)

| Type (declared)                                                                        | Delivered value                        | Proposed display                                                                         | Fallback (stays raw)                                                                              |
| -------------------------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `DATE` (any case)                                                                      | number, epoch ms                       | `YYYY-MM-DD` from the **UTC** calendar day                                               | non-finite, non-number, \|ms\| > 8.64e15 (`Date` range), or `Math.abs(ms) > 8.64e15`              |
| `TIMESTAMP`, `TIMESTAMP_S`, `TIMESTAMP_MS`, `TIMESTAMP_NS`, `TIMESTAMP WITH TIME ZONE` | number, epoch ms (possibly fractional) | `YYYY-MM-DDTHH:mm:ss.sssZ`, **ms only**, `Z` always, computed from UTC (never locale/TZ) | non-number/non-finite, out of `Date` range, **and — per the open decision — any non-integral ms** |
| `TIME`, `TIME WITH TIME ZONE`                                                          | bigint, µs since midnight              | `HH:mm:ss` when µs%1e6 == 0, else `HH:mm:ss.ffffff`; never a Unix instant/date           | non-bigint, negative, ≥ 86_400_000_000                                                            |
| everything else                                                                        | —                                      | unchanged `String(value)` / existing decimal & nested paths                              | —                                                                                                 |

Explicit non-goals restated as observations that force them:

- **No `new Date(number)` catch-all**: `TIME` is µs (bigint) — `aliasProbe` shows a ms value fed to a `TIME` column renders `474:46:04.800000`; and `BIGINT 1700000000000` is a valid integer in the same band as DATE ms.
- **No fabricated sub-ms digits** for `TIMESTAMP_NS` (already lossy upstream — see §6) and no offset for `TIMESTAMPTZ` / `TIME WITH TIME ZONE` (unrecoverable — §5).
- **No fabricated timezone for naive `TIMESTAMP`**: display is a UTC-based convention for the delivered wall time, not a claim about the original zone.
- **No formatting of untyped numbers** (`SqlPanel`, `Record`, nested leaves): they have no declared type at all.
- **No locale/`Intl`/`toLocaleString`**: the browser under test was `Asia/Singapore` (−480) and every delivered value was TZ-independent; `toISOString()`-style UTC arithmetic is what the editor already uses.
- **Never** feed display strings into overlay ops, filters or export (unchanged).

---

## 8. Editor-helper extraction feasibility

`temporalDraft(value, family)` in `apps/web/src/edit/typed-input.ts` (private, `typed-input.ts:137`; family mapping `temporalFamily`, `typed-input.ts:104`) already produces exactly the strings scope A wants — observed for every temporal row in §2: `2024-02-29`, `2024-02-29T13:45:12.123Z`, `13:45:12.123456`, `1970-01-01`, `9999-12-31`.

- **Byte-equivalent extraction is possible**: same function, same inputs, same family mapping ⇒ the existing editor seeds cannot change. The only mechanical change is exporting it (plus its `TemporalFamily` derivation) from `typed-input.ts` and calling it from `format.ts`. The editor's `toISOString()`/slice logic _is_ the proposed display logic.
- **Cases where the display would inherit editor behaviour (all observed, not inferred):**
  1. fractional ms are truncated: `1709214312123.456` → `…T13:45:12.123Z`;
  2. negative sub-ms snap toward the epoch: `-0.001` → `1970-01-01T00:00:00.000Z` (a 1 µs error in the displayed instant);
  3. `TIMESTAMP_NS` is displayed at ms precision although the delivered float carries a lossy sub-ms tail;
  4. out-of-range values (`8640009504000000`, `185542587100800000`) already fall back to the raw string — which is also the proposed fallback, so no change there.
- **One trap to state explicitly:** `temporalFamily` matches `TIME` exactly, so the string `TIMETZ` maps to `text` while the string the engine actually prints — `TIME WITH TIME ZONE` — maps to `temporal`. Extraction must preserve that mapping (byte-equivalence) or the maintainer must decide, separately, that display coverage for `TIME WITH TIME ZONE` is wanted.

So the extraction is safe **provided** the maintainer accepts (1)+(2) as the display contract, or chooses the stricter alternative (raw fallback for non-integral ms), which would make display differ from the editor draft for those payloads.

---

## 9. Residuals under scope A

1. **Nested preview** (`grid/nested-preview.ts`): temporal leaves inside STRUCT/LIST/MAP keep raw epoch numbers, even though the child types _are_ available (`{"ts":1709164800000,"d":1709164800000,"t":0}`, `[1709164800000,-86400000]`).
2. **Record tree** (`record/record-tree.ts`): `RecordRowInput` carries no types at all; every temporal leaf is `summary: "1709164800000"` / `"49512123456"`. Fixing this needs a type channel through full-depth traversal (WF-O2).
3. **SQL results** (`sql/SqlPanel.tsx:399`): `formatCell(cell)` with no type. Arrow field types are in the batch but unused, and the **DuckDB** type string is absent, so a fix needs an Arrow→DuckDB type mapping or a separate Arrow-unit contract (WF-O2). Under scope A this surface keeps showing raw epoch numbers while the grid no longer does — a **new, visible divergence**.
4. **`TIMESTAMP_NS`**: sub-ms digits are already lossy before the DOM; scope A must not imply ns accuracy.
5. **`TIMESTAMPTZ` / `TIME WITH TIME ZONE`**: original offsets are unrecoverable; display is UTC (zoned) or bare wall time (TIME-family) only.
6. **`TIMESTAMP 'infinity'`**: cannot be formatted; it throws in Arrow's accessor during the projection (see §10).
7. **`INTERVAL`**: stays `<8 bytes>` (it is `text` family in the editor too — unchanged by scope A).
8. **`DATE 'infinity'` / far-future dates**: stay raw (no JS Date), which is consistent but means "some DATE cells are dates and some are numbers" — worth an explicit note in the WF-01 contract.

---

## 10. Blockers, and probes that failed (verbatim)

- **No engine/package change is required for the formatter itself.** The declared DuckDB type string plus a `number`/`bigint` carrying ms/µs is sufficient (observed end-to-end through the real client, base and overlay).
- **`TIMESTAMP 'infinity'` cannot be fixed in `format.ts`.** Observed: `vector.get()` throws `TypeError: 9223372036854775 is not safe to convert to a number.` inside `getTimestampMicrosecond`, and both `projectBatchToRows` and `projectOverlayPage` throw the same error for the whole window (`logs/probe.json` → `appProjection`). The failure is before formatting; fixing it means changing the projection boundary, which the spec forbids for this row. Recommended: record as an honest limitation, not a scope-A regression.
- **Failed probe (kept as data):** `TIMESTAMPTZ '2024-02-29 13:45:12.123456' AT TIME ZONE 'America/New_York'` →
  `EngineQueryError: Failed to execute 'send' on 'XMLHttpRequest': Failed to load 'https://extensions.duckdb.org/v1.4.3/wasm_mvp/icu.duckdb_extension.wasm'.`
  The harness only serves committed pinned binaries, so the ICU (timezone-name) extension is unavailable: **no named-timezone conversion is observable in this repo's harness.** It is not needed for scope A (display is UTC-only) but it means "what a `TIMESTAMPTZ` shows when converted to a named zone" was **not** verified.
- **`TIME WITH TIME ZONE` through a file path is not observable here**: Parquet cannot carry a `TIMETZ` column, so the overlay/file row for type #8 in §2.1 is expression-path only (the DDL fixture could not include it).

---

## 11. What I did NOT verify (explicit)

1. **No React rendering.** I did not mount `DataGrid`, `SqlPanel` or the Record panel; I called the exact functions with the exact arguments those components pass (verified by reading the call sites) and compared their outputs. So "the DOM shows X" is _inferred_ from `formatCell(cell, column.type, parsedType) === X`, not observed as pixels.
2. **No end-to-end app journey** (file picker → grid) over a temporal Parquet; the engine client, provider class and projections were real, but the app shell was not driven.
3. **No non-UTC engine-side timezone.** The WASM engine's own zone is UTC; the browser was `Asia/Singapore`. Delivery and `toISOString()` output were TZ-independent, but I did not run the engine under a different server-side/display zone.
4. **No CSV/JSONL temporal type sniffing** (only Parquet + live SQL).
5. **`TIMESTAMP_S`/`TIMESTAMP_MS` are only observed through live SQL** — a Parquet round-trip collapses both to `TIMESTAMP` (observed), so their file-path behaviour is only observed in that collapsed form.
6. **`HUGEINT` in a file** arrives as `DOUBLE` (observed) — the true `HUGEINT`→`Decimal[38e0]` mapping was observed only through live SQL.
7. **No named-timezone (`icu`) path** (see §10).
8. **`TIME WITH TIME ZONE` via any file** (see §10).
9. **No observation of the _rendered_ `title`/aria strings or of copy behaviour in a real clipboard.**
10. **Nothing was verified about editor submission/export fidelity** (out of scope; not touched).

---

## 12. Log paths (all under `/tmp/assay-wf-01p`)

| File                                            | Contents                                                                                                                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `logs/probe.json`                               | **raw probe output** — 44 expressions, 27 base columns × 2 rows, 27 overlay columns × 2 rows, alias probe, precision probe, app-projection probe, profile, record tree, console lines |
| `logs/matrix-render.txt`                        | machine-rendered tables from `probe.json` (§2.2 above is a copy)                                                                                                                      |
| `logs/duckdb-cli-fixture.log`                   | DuckDB **CLI** v1.5.5 commands + the parquet DESCRIBE when writing the fixture (fixture generation only; no matrix row depends on it)                                                 |
| `logs/vite-dev.log`                             | the dev server log for the probe page                                                                                                                                                 |
| `logs/probe-sources/`                           | verbatim copies of the probe-only files (`probe.ts`, `probe.html`, `wf01p-probe.spec.ts`, `playwright.wf01p.config.ts`, `render-matrix.mjs`)                                          |
| `wf01p-temporal.parquet`, `gen2.sql`, `gen.sql` | the synthetic fixture and its generator (probe-only, never committed)                                                                                                                 |

---

## 13. The single decision for the maintainer (WFD-06)

**Approve, amend or reject the scope-A temporal contract above — specifically the one point the evidence leaves open: whether a fractional-millisecond payload (`TIMESTAMP…123456` → `1709214312123.456`, `TIMESTAMP_NS` → `…123.4568`, pre-1970 `-0.001`) is displayed at **millisecond precision by reusing the editor's `temporalDraft` byte-for-byte** (accepting the truncation and the `-0.001 → 1970-01-01T00:00:00.000Z` snap), **or** falls back to the raw delivered number whenever `delivered*1000` is not an integer** (bit-honest, but the grid then disagrees with the editor draft for those cells).**

_Stopping here. No WF-01 implementation, no formatter/editor/fixture/test change, no acceptance claim for WF-01._
