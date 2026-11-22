---
'@assay/web': patch
---

refactor(b1/eng-2): read the repair preview's affected count through the typed `engine/repair-preview-count` op instead of composing and running SQL through the generic `engine/query` op. `readRepairPreview` now asks the engine for the count (`engineClient.repairPreviewCount`, carrying the plan as data in canonical pair order) and keeps the `overlay-range` example read and the pure domain `liveRowCount` fold exactly as they were, so `scanned`, the example window and the preview's copy are unchanged. The web's `repairAffectedPredicate` is now a thin wrapper over the engine's exported builder (`@assay/engine-duckdb`'s `repairAffectedPredicate`), so the example filter and the affected count are one definition and cannot diverge. The previous host composition (`repairAffectedCountSql`) is still present for this commit only, with a parity test asserting the engine op's statement is byte-identical to it for every plan shape the preview can read.
