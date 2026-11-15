---
'@assay/web': patch
---

fix(r2): project DuckDB's ±infinity timestamps without throwing (D6, projection-boundary guard).
DuckDB encodes `TIMESTAMP 'infinity'` / `'-infinity'` as the ±int64-maximum sentinels, and Arrow's
`get()` throws on those raw bits for the `Timestamp<SECOND>` / `<MILLISECOND>` / `<MICROSECOND>` units
(`bigIntToNumber`'s safety check; µs divides by 1000 first) _before_ any formatter runs — one infinite
timestamp used to throw away the whole delivered window/page, base and overlay alike. The two projection
helpers (`projectBatchToRows` / `projectOverlayPage`) now detect those three units through the vector's
structural type slice (`Type.Timestamp` + `TimeUnit`, no apache-arrow dependency) and read the exact
raw `BigInt64Array` per cell: the sentinel values render DuckDB's own sentinel text `infinity` /
`-infinity` (the pinned D6 refinement — the raw bigint is not the value's meaning and the text invents
no locale, timezone or precision). The delivered negative sentinel is `-(int64 max)` =
`-9223372036854775807`, not the bare int64 minimum — DuckDB reserves that as an internal marker
(pinned by the fixture round-trip through DuckDB v1.5.5: the committed file stores zero int64-minimum
bits for its `'-infinity'` row); the reserved minimum is diverted to the same text defensively. Every
other cell keeps the untouched `get()` path, so finite DATE/TIMESTAMP/TIME rendering stays
byte-identical (WF-01 WFD-06 = B) and `Timestamp<NANOSECOND>` — which does not throw — stays entirely
on today's raw-lossy-number path. Display-copy only: no engine, protocol, storage, overlay, editor,
filter or export change (untyped SQL results share the same helpers and gain the same guard). Adds one
minimal Parquet fixture (`fixtures/parquet/temporal-infinity.parquet`, ADR 0038) with finite µs
negative controls, both ±infinity sentinels and a `TIMESTAMP_NS` raw-class column including the ns
sentinel (which never throws and stays raw), plus unit regressions on real Arrow vectors and a
real-engine browser spec covering the base path, a sorted overlay window (`projectOverlayPage`) and
the ns raw rule.
