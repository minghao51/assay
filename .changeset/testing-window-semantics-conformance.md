---
'@assay/testing': minor
---

feat(m2-2): extend the engine conformance suite with filtered/sorted-window scenarios — `window-filter-sort` (filtered windows match declared values; filtered `rowCount` matches; sort asc/desc including engine NULL ordering; filter+sort composition; window clamping/validation under filters; natural-order baseline for absent filters/sort) and `predicate-error-reuse` (invalid/hostile filter probes reject with a classified engine error and the engine stays ready and reusable; breakout probes are contained with view data and the registry intact). The subject surface gains `windowSemantics`, `rejectingFilters`, and `breakoutFilters` declarations (engine-SQL texts plus exact expected outcomes), and `ConformanceEngineClient.rowCount` takes an optional filtered-count options object; `ConformanceWindow` carries optional `filters`/`sort`.
