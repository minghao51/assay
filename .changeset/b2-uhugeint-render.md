---
'@assay/web': patch
---

fix(b2): render `UHUGEINT` grid cells as their exact unsigned 128-bit value.

DuckDB-WASM delivers `UHUGEINT` as Arrow `FixedSizeBinary(16)` — a plain
`Uint8Array` of 16 little-endian **unsigned** bytes. It is not decimal-like (no
precision/scale), so the m4-4 decimal decoder deliberately exempted it and
`formatCell`'s `Uint8Array` branch summarized every cell as `<16 bytes>`. The
new pure `grid/uhugeint.ts` decodes the payload exactly (verified byte order,
not assumed: a probe of the pinned transport — duckdb-wasm 1.32.0 / engine
v1.4.3 / Arrow 17 — returned `0` → `00×16`, `1` → `01 00×15`,
`18446744073709551615` → `ff×8 00×8`, `2¹²⁸−1` → `ff×16`) and `formatCell`
consults it through the declared parsed type before the generic byte summary.
BLOB keeps its `<N bytes>` summary (including a 16-byte BLOB), `HUGEINT` and
`DECIMAL` keep their signed decoding, a wrong-width payload is never
mis-decoded, and the focused-cell copy (which composes `formatCell`) copies the
exact rendered value; engine-side raw export is untouched. The two
defect-pinning assertions and the `decimal.ts` boundary notes are updated.
