---
'@assay/web': patch
---

fix(ux-2): human open/status copy, `data-phase` pins, open-completion announcement + focus move. The open-flow status renders human copy ("No file open" / "Opening…"; ready folds into the info line) and carries a stable `data-phase` machine token; the info line drops the engine handle ("Dataset · N rows · M columns", with `assay_t1` kept in the SQL pane hint); and a completed open announces through a polite `role="status"` live region and moves focus off the Open button to the schema panel. Copy is value-free throughout (ADR 0025).
