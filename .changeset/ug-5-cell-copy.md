---
'@assay/web': minor
---

feat(web): copy the focused grid cell's display value (ug-5). Ctrl/Cmd+C on a focused, non-editing cell writes the exact rendered text — composed through the same `formatCell` call the cell renders with, never the raw value — to the local clipboard and announces one value-free result through the existing single polite live region (`Value copied.` / `Nothing to copy — this cell is empty.` / `Copy failed — the clipboard is unavailable.`). An open editor and its controls keep native copy, an empty/NULL cell writes nothing, a missing or rejecting clipboard API cannot throw, and a row-focused row is never intercepted. User-initiated and local only: no document-level listener, no state/history mutation, no new telemetry and no dataset value in any announcement, log or event (ADR 0025).
