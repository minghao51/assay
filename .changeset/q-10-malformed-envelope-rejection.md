---
'@assay/engine-duckdb': patch
---

fix(q-10): reject malformed request envelopes at the protocol seam for every
request kind, not just the overlay/export subset — a malformed
`range`/`row-count`/`schema`/`open`/`query` (or any other recognised request)
now answers one typed, value-free `engine/error` naming the request class and
field path instead of being silently dropped.
