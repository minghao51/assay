---
'@assay/web': minor
---

feat(rd-7): add the one global Help guide, and close the workbench redesign with the recorded
accessibility/performance evidence and the cumulative RD-R/RD-T accounting.

A new header **Help** control opens a single minimal guide in a native `<dialog>` (accessible name
"Workbench guide"): what this is → the four tasks → formats and locality → keyboard. The content is the
approved (D-15) copy, byte-exact, and pins each string in both a component and a browser test. The guide is
a genuine modal — the page behind it is inert, Tab stays inside it, Escape and the Close control both close
it, and focus returns to the control that opened it.

Modal ownership stays app-local and arbitrated: at most one of the guide, the export dialog, the telemetry
Settings panel and the first-run telemetry disclosure is open at a time, and each closes back onto its own
opener (the Settings panel previously dropped focus to `<body>`). Nothing in the engine, grid, export,
validation, diff, pipeline, report bytes, session hooks or telemetry (copy, consent, storage, emission)
changed, and the existing accessibility/keyboard/theme/recovery suites pass unmodified.

No wall-clock performance gate is added (D-04): the measured baseline (1024×700 first paint ≈1.35 s picker→
first row, a task switch ≈26–27 ms with zero extra engine requests, and the unchanged ≤140 px ready-top and
grid-window pins) is recorded in the design record instead. RD-T07 is recorded as an explicit accepted
limitation — no participants, no AT study, and therefore no usability claim.
