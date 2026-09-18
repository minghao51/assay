---
'@assay/testing': minor
---

feat(m4-2b): add the `overlay-insert-edits` conformance scenario pinning cell edits on inserted rows. The suite's `EngineConformanceSubject` gains `overlayInsertEdits` (a focused `ConformanceOverlayInsertEditsDataset`: base + ops that insert a row, edit a cell the insert left NULL, override a value the insert carried, edit-then-revert a third, and rename the edited columns) and `stageOverlayInsertEditsFile()`. The scenario asserts the effective schema, the live count, the full effective window (row order + merged values), and a CSV+JSONL export round-trip — the surfaces where the m4-2 composer dropped inserted-row edits (engine-duckdb derives every pin with DuckDB CLI 1.5.5 over the identical composed SQL, recorded in the subject's derivation transcript). The fake-engine proof gains a `skipsOverlayEdits` case showing the scenario detects the dropped-edit defect.
