# R2 probe — `TIMESTAMP 'infinity'` throws before any formatter

**Date:** 2026-11-14. **Row:** [EW-10](20261113-ew10-first-wave-integration.md) §6 **R2** — no owning
row; ownership decided 2026-11-14 (projection-boundary guard, accepted in the
[acceptance record](20261114-post-r1-decisions-accepted.md), D6). **Status:** probe complete; **no source,
test, fixture, dependency or protocol change**; reproducer and artifacts under `/tmp/assay-r2/`; nothing
pushed.

**Authority:** [EW-10 §6](20261113-ew10-first-wave-integration.md) R2 →
[WF-01P temporal matrix](../../reviews/2026-11-10-wf01p-temporal-matrix.md) §10 →
[product/14 WFD-06=B](../../product/14-web-interface-followup-spec.md) → the acceptance record. This
record reports a reproducer and options; it does not re-open WF-01 or decide policy.

## 1. Baseline and method

- Repo `/home/howt/work/dataworkbench` at `3280e85`, tree clean before and after; read-only.
- `apache-arrow@17.0.0` exactly as resolved by `packages/engine-duckdb` (the version the web grid
  consumes), loaded through `createRequire` from that package.
- Synthetic vector only: a `TimestampMicrosecond` vector built from a raw `BigInt64Array` with the two
  int64 sentinels DuckDB uses for `infinity`/`-infinity`
  (`9223372036854775807`, `-9223372036854775808`) plus a zero control; a `TimestampNanosecond` control
  vector.
- Reproducer: `/tmp/assay-r2/repro.mjs` (17 lines of assertions, no engine, no network, no installs).

## 2. Reproducer output (verbatim)

```text
type Timestamp<MICROSECOND> unit 2 length 3
get(0) THROWS TypeError: 9223372036854775 is not safe to convert to a number.
get(1) => number 0
get(2) THROWS TypeError: -9223372036854775 is not safe to convert to a number.
toArray BigInt64Array 9223372036854775807,0,-9223372036854775808
ns get(0) => 1700000000123.4568
ns get(1) => 9223372036854.775
```

The microsecond vector's **raw backing array is intact** and exact; only the convenience accessor throws.
The nanosecond control does **not** throw — it silently returns a lossy `number`, which is exactly why
WF-01 keeps `TIMESTAMP_NS` raw at the display layer.

## 3. Root cause

`vector.get(i)` → `GetVisitor.visitTimestampMicrosecond` →
`getTimestampMicrosecond({ values }, index) = divideBigInts(values[index], 1000n)`
(`apache-arrow/visitor/get.mjs:86`) → `divideBigInts` calls `bigIntToNumber(number / divisor)`
(`util/bigint.mjs:35`), and `bigIntToNumber` throws when the bigint is outside ±`Number.MAX_SAFE_INTEGER`
(`util/bigint.mjs:18-24`). For the infinity sentinel, `9223372036854775807n / 1000n =
9223372036854775n`, which is > 9,007,199,254,740,991, so the accessor throws **inside Arrow, before the
value becomes a cell**.

Both projection paths call the accessor unguarded for every cell:

- `projectBatchToRows` — `apps/web/src/grid/provider.ts:106-119` (`column.get(rowIndex)`);
- `projectOverlayPage` — `:121-143` (`dataColumns.map((column) => column.get(rowIndex))`).

Therefore **one infinite timestamp fails the whole delivered window/page** (base and overlay alike); the
error is thrown while projecting the batch, not while rendering a cell. **A formatter guard cannot fix
it** — `formatCell` never sees the value (confirmed by WF-01P and by this reproducer).

## 4. Exact-precision constraint it must not break

WF-01 / WFD-06=B (accepted 2026-11-10): typed DATE/TIMESTAMP/TIME cells render UTC ISO-like text at the
**exact delivered precision**, and a `TIMESTAMP_NS` is **always rendered raw** because an integral
`ms*1000` is not proof of recovery. Storage, overlay, editor seeds, filters and export stay untouched;
nested/Record/SQL parity is **WF-O2**, not R2. Any fix must therefore:

- never route a `TIMESTAMP_NS` through `get()` as the display value;
- keep the existing DATE/TIMESTAMP/TIME rendering for finite values byte-identical;
- not change the Arrow payload, the engine protocol, or the CSV export path (which pins raw values).

## 5. Options

| Option                                                                                                                                                                                                                                                        | Cost / risk                                                                                                                                                                                                            | Verdict                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| **(a) Projection-boundary guard** — in the two projection helpers, read the raw int64 for microsecond timestamps (the backing `BigInt64Array` via `toArray()`/`data.values`), and emit a sentinel for the two int64 extremes; leave ns/normal paths unchanged | One small web/grid row + a minimal golden Parquet fixture (`TIMESTAMP 'infinity'`, `'-infinity'`, finite controls) + unit/component regression tests. Risk: the sentinel's visible text is a display decision (below). | **Accepted direction** |
| (b) Per-cell `try/catch` around `get()` returning a generic "unreadable" marker                                                                                                                                                                               | Masks any other accessor bug as the same marker, is slower on the hot projection path, and does not use the exact raw value that is available.                                                                         | Not recommended        |
| (c) Formatter guard only                                                                                                                                                                                                                                      | Impossible: the throw precedes the formatter (this probe + WF-01P). At most defense-in-depth after (a).                                                                                                                | Not viable             |
| (d) Record as a limitation                                                                                                                                                                                                                                    | One infinite value makes the whole grid page unusable; not honest for a local data workbench unless the case is impossible.                                                                                            | Not recommended        |

### 5.1 The sentinel-rendering sub-question (open, needs the brief to pin it)

The accepted decision says "emit the raw value (same fallback class as `TIMESTAMP_NS`)". For
microseconds, the raw value is `9223372036854775807` (or `-9223372036854775808`) — exact, but not the
value's meaning. Two honest renderings:

- **raw int64** (literal accepted reading): `9223372036854775807` — no formatting, but a reader cannot
  tell it means infinity;
- **DuckDB sentinel text**: `infinity` / `-infinity` — DuckDB's own textual value, no locale, timezone
  or precision invention, and distinguishable from a real epoch microsecond.

Recommendation for the R2 brief: **the sentinel text** (`infinity` / `-infinity`) for the two int64
extremes, with the raw-int64 behaviour recorded as the fallback if the maintainer prefers the literal
reading. This is a display-copy decision, not a new format; the brief must state which one is pinned and
must test the negative (a finite max-range-like value is not mislabelled).

## 6. What this changes for the R2 row

- The row is **web/grid**, not engine/protocol: `apps/web/src/grid/provider.ts` plus a fixture and tests.
- The guard must be unit-aware (only `Timestamp<MICROSECOND>` needs the raw path; `MILLISECOND` stays as
  today; `NANOSECOND` must not regress WF-01's raw rule).
- The fixture rule applies (dataset-shape bug → minimal golden fixture + regression test); it must be
  generated through the documented fixture script and manifest, never committed as ad-hoc bytes.
- Scope excludes WF-O2 (nested/Record/SQL) and any engine change.

## 7. Gates

Docs-only: `pnpm exec prettier --write` on this file, `pnpm format:check`, `pnpm docs:links:check`,
`pnpm adr:index:check`, `git diff --check`. No unit, build or browser claim; no runtime change was made.
