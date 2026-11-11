---
'@assay/web': patch
---

fix(wf-01): render typed temporal grid cells at their exactly delivered precision (WFD-06 = B,
scope A). A measured probe of the real engine showed that no temporal payload is ever a JS `Date`
(0 of 152 cells): `DATE`/`TIMESTAMP`/`TIMESTAMP_S`/`TIMESTAMP_MS`/`TIMESTAMP_NS`/`TIMESTAMP WITH
TIME ZONE` arrive as epoch **millisecond** numbers (fractional when the column carries µs) and
`TIME`/`TIME WITH TIME ZONE` as a **bigint of microseconds since midnight**, so cells rendered raw
(`1709164800000`, `1709214312123.456`, `49512123456`) and the `Date` branch was dead code for engine
data. Scalar cells — and the focused display-value copy, which composes through the same call — now
render UTC ISO-like text: `YYYY-MM-DD` for `DATE`; `YYYY-MM-DDTHH:mm:ss[.SSS[SSS]]Z` for the
lossless timestamp families, where the fraction width follows the value (no fraction when the µs
part is zero, three digits for milliseconds, six for microseconds, recovered as
`us = Math.round(ms * 1000)`); and
`HH:mm:ss[.SSSSSS]` for times, never a Unix instant and never a date. Pre-1970 sub-millisecond
values keep their exact instant instead of snapping onto the epoch. Any payload whose precision is
not exactly recoverable keeps today's raw text, and a `TIMESTAMP_NS` column always does: the
Arrow→rows projection folds nanoseconds into a float millisecond, so the sub-µs digits are
discarded before display and the column's declared precision is not representable — an integral
`ms * 1000` is a rounding artefact, not evidence of recovery, so ns cells stay raw rather than
assert a µs precision the transport no longer carries. The same raw fallback covers every other
lossy payload — non-finite/out-of-range values, non-integral products in the lossless timestamp
families, strings, untyped columns, `INTERVAL` and NULL — so nothing is truncated or invented.
Display only: raw storage, overlay rows, editor drafts (unchanged ms-only), filters, casts and
export are untouched, and nested previews, the Record tree and untyped SQL results keep raw
temporals (WF-O2). Adds one minimal temporal Parquet fixture
(`fixtures/parquet/temporal.parquet`) so the real engine can exercise a declared `DATE` /
`TIMESTAMP` / `TIMESTAMP_NS` / `TIME` column; no other fixture changes.
