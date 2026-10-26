---
'@assay/web': patch
'@assay/data-sources': patch
---

fix(ug-2): rebuild the first-run idle screen and add picker hints.

`@assay/web`: the idle state now states the product capability
("Inspect, query, validate, compare, and repair local datasets.") and the
formats the Open control accepts ("Opens .parquet · .csv · .jsonl · .json").
The old scaffold/roadmap/docs block is removed; opening and open-error states
keep their existing "Opening…" status and alert and never render the welcome
copy. The primary "Open a data file…" control is unchanged.

`@assay/data-sources`: the File System Access picker now passes a
standards-valid `types` accept map covering exactly `.parquet`, `.csv`,
`.jsonl` and `.json` (no `*/*` wildcard) with `multiple: false` and
`excludeAcceptAllOption: false`, so the native dialog keeps its All files
option. The hidden-input fallback sets the matching
`accept=".parquet,.csv,.jsonl,.json"`. Cancel, single-file selection,
capability detection and fallback routing are unchanged.
