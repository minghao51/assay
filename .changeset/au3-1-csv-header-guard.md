---
'@assay/engine-duckdb': patch
'@assay/web': patch
'@assay/testing': patch
---

fix(au3-1): guard CSV export column **names** against formula injection

CSV export now apostrophe-prefixes a column name when it begins with
`=`/`+`/`-`/`@` or contains TAB/LF/CR anywhere, so a dataset column literally
named `=SUM(A2:A3)` no longer writes a live formula as the header row. The
header alias is applied only on the CSV path (json/jsonl/parquet/arrow stay
byte-identical — names are data keys there) and sits above the composed
base/insert union, so it covers every branch. The value guard's trigger set
also gains LF (`chr(10)`), matching OWASP, in both the engine and the web
validation-report CSV mirror. The conformance `export-round-trip` scenario
gains a bait-metadata header leg (synthetic hostile renames re-opened through
the engine's ordinary CSV path).
