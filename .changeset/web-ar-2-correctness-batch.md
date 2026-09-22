---
'@assay/web': patch
---

fix(ar-2): web correctness batch — nine audit findings (AR-W1/W2/W3/W4/W5/W8/W9/W11/W13).

- **AR-W1 (critical):** the cell editor is now keyed by the logical `RowId`
  captured at `beginEdit`, and the commit resolves against that id instead of
  the live viewport position. A rejected draft that stays open across an
  accepted sort/filter (a fresh data epoch that renumbers rows) can no longer
  commit to whatever record shifted into the stale position. The editor follows
  the captured logical row to its new position; the e2e drill proves the old
  code committed to the shifted row.
- **AR-W2:** a `scrollRequest` is consumed exactly once (per `seq`); a later
  `totalRows` change (filter/insert/delete) no longer re-fires a consumed
  jump-to-row.
- **AR-W3:** diff-report CSV sanitizes only string cells; numeric metrics pass
  through as numbers, so negative metrics like `-0.5059…` are no longer
  apostrophe-prefixed text.
- **AR-W4:** two React error boundaries (top-level + around the grid) with
  static, value-free recovery copy; the thrown error is logged to the console,
  never rendered (ADR 0025).
- **AR-W5:** the engine client is disposed once on `beforeunload`/`pagehide`
  (the only release op the current client exposes). The comparison B-side
  transient open remains the recorded PT-H carry-over (no `closeTable`/
  `profileComparison` op exists — no engine change was made).
- **AR-W8:** the record-inspector tree is bounded by length (100) and depth (6)
  caps mirroring `nested-preview`, with honest truncation markers and a
  "Show all values" expand affordance (10 000 / 32 bound).
- **AR-W9:** contract import is session-token guarded; a read resolving after a
  re-open is discarded.
- **AR-W11:** filter input ids are collision-safe (per-code-point hex encoding),
  so `a.b` and `a-b` no longer share a DOM id and labels point at the right
  input.
- **AR-W13:** `openDataFile` has a completion generation guard; a late-resolving
  picker/open chain cannot clobber a newer phase.
