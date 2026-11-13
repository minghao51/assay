---
'@assay/web': minor
---

feat(wf-06): preserve the live session across replacement cancel and failure.

A ready-state **Open a data file…** now runs a synchronous gate before any dialog, picker or
await: an open cell editor (any kind, including the boolean editor, which has no blur handler),
an unsettled history commit, any outstanding column cast pre-check, the grid's filter/sort
epoch and an already-owned modal each refuse the gesture with a value-free notice and leave the
live session untouched. A clean session goes straight to the chooser; a **dirty** session (an
applied outcome in the active history prefix) gets a native `<dialog>` guard with **Stay** /
**Export a copy…** / **Choose a replacement file…**, where Escape is Stay and export-first opens
the existing exporter without touching the session.

The chosen file is prepared as a candidate against its **own** empty overlay box while the live
session keeps rendering, then adopted in one synchronous step (session reset → history/overlay
republish → provider overlay rebind → identity/panels/ready phase → telemetry → intent cleared);
adoption calls no `model.refresh()` and never re-opens the candidate. Cancelling the chooser or
a candidate that cannot be opened leaves the live data, staged edits, history, validation,
comparison, SQL and pipeline state exactly as it was. No autosave, save, persistence or
"recovery" promise is added, and no edit, export, report or DCR semantics change.

Retention (ADR 0047): replacing a session keeps the retired table registered in the worker until
the worker is disposed — there is no per-table release primitive, and this change adds none. No
bounded-retention, "zero orphan" or leak-free claim is made; a candidate that fails after
registration or a superseded late return can retain one table.
