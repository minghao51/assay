---
'@assay/engine-duckdb': patch
'@assay/testing': patch
---

fix(ar-1): engine security + wire-gate hotfix — the 2026-09-22 audit's four
engine findings.

- **AR-E1 (critical):** the CSV formula-injection guard no longer has a BLOB
  bypass. Scalar DuckDB BLOB aliases (`BLOB`/`BYTEA`/`BINARY`/`VARBINARY`;
  `DESCRIBE` canonicalizes all four to `blob` at the pinned 1.5.5) are now a
  distinct `blob` type family, and the CSV exporter **hex-encodes** every
  scalar BLOB (`hex(x)`) on both the base and insert branches. Policy: raw
  BLOB bytes reach DuckDB's CSV writer verbatim (a live formula-leading cell)
  and cannot be passed to the string guard's `contains`/`left` (Binder Error);
  hex is `[0-9A-F]`-only, so no spreadsheet parser can read it as a formula,
  and `from_hex` recovers the bytes losslessly. Non-CSV formats keep the raw
  value. A new `blob-csv-export-sanitized` conformance scenario pins the hex
  cells for the overlay (cast-to-BLOB + BLOB-typed insert) and overlay-free
  base (real BLOB Parquet) legs; `export-rewrite.spec.ts` adds the end-to-end
  UI pin. Fixes a `SECURITY.md` probeable invariant and an `AGENTS.md` hard
  rule.
- **AR-E2:** the plan wire gates are identifier-aware. `scanPlanSql` now
  blanks quoted-identifier interiors in its structural code view (exposing the
  decoded tokens separately), so a column named `a;b`, a column containing
  `UNION ALL`, or a column named exactly the relation binding no longer reads
  as SQL structure; the relation-binding counters match the identifier tokens,
  so every hostile plan rejection is unchanged.
- **AR-E3:** `DuckDbEngineClient.send` re-checks the lifecycle status and
  rejects with `EngineDisposedError` when disposed (the internal graceful
  dispose send excepted), and pending entries are re-failed after
  `worker.terminate()`, so an op that passed `ensureReady()` before `dispose()`
  can no longer hang forever.
- **AR-E4:** `assertNoReservedNames` now checks the **base** column names as
  well as the effective ones, so a base column named exactly the reserved
  ordinal alias (`assay_overlay_ord`) fails fast with the readable reserved-name
  error even when a rename overlay moves it away.
