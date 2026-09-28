---
'@assay/web': patch
---

fix(ux-3): display polish pack. Profile statistics now render display-rounded to six
significant digits (`format-stats.ts`'s `roundForDisplay`), so the audit's raw-float noise
("Stddev 1.6329931618554474", "p99 955.0500000000002") reads as "1.63299"/"955.05". This is a
display-only change: the exact doubles remain in the JSON/CLI envelopes and export
byte-stability is untouched. (The shared `@assay/diff` `roundForReport` convention is six
_fractional_ digits and is unchanged; the diff panel's committed-fixture delta lines were
already within six significant digits and are not affected.) The editing toolbar drops its
duplicate Undo/Redo pair (the history panel owns the single time-travel pair, and the
`edit-undo`/`edit-redo` pins migrate to `history-undo`/`history-redo`). Every top-level
ready-state section now carries an h2 (Schema, Editing, Export, History, Validation, Compare,
Filters, Grid, Record, SQL, Profile), asserted by a new component heading-map pin. The grid
footer's request counters move behind a collapsed-by-default `<details>` "Diagnostics"
disclosure; the shared grid-stats reader reads `textContent` so counters stay observable while
closed. `role="grid"` moves onto the scroll viewport (the footer's disclosure role must not be
an owned child of the grid) — grid semantics unchanged. No telemetry; nothing logged.
