---
'@assay/web': patch
---

fix(r-13): show a nested `UHUGEINT` leaf's exact value in the grid preview and the Record inspector.

A `UHUGEINT` inside a struct or list used to render as `<16 bytes>`, even though a top-level `UHUGEINT` cell already showed its exact unsigned 128-bit value. The nested preview now reuses the same decoder for a declared `UHUGEINT` position, and the Record inspector passes the parsed schema types through to its tree summaries, so a value above the signed 64-bit range shows its exact digits instead of `<16 bytes>`. BLOB keeps its `<N bytes>` summary at any width, `HUGEINT`/`DECIMAL` keep their signed decoding, a payload whose width is not 16 bytes at a `UHUGEINT` position keeps the byte summary, and untyped SQL results are unchanged.
