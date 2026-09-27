---
'@assay/engine-duckdb': patch
---

fix(au3-13): reject unpaired UTF-16 surrogates at the cell-literal boundary. A
user-entered `cell-set`/insert value carrying a lone surrogate (`\uD800`–`\uDFFF`
with no pair) previously composed SQL that the wire encoder (`TextEncoder`/N-API
UTF-8) silently rewrote to U+FFFD, so the edit materialized and exported as a
_different_ value. `cellLiteralSql`/`cellLiteralRawSql` now reject such values
loudly and value-free at compose time — before any SQL reaches the engine — with
the message `cell text contains an unpaired surrogate and cannot be materialized
losslessly; replace it with a valid character`. Well-formed surrogate pairs,
BMP text, and base-data passthrough (a U+FFFD already in a source file) are
unchanged.
