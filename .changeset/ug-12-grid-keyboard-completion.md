---
'@assay/web': minor
---

feat(web): keyboard completion for grid jumps (ug-12, findings UG-13/UG-26). Two bounded additions.

(a) The roving grid now carries an explicit keyboard ring: `.grid-cell:focus-visible { outline: 2px solid var(--color-focus); outline-offset: -2px; }`, reusing the shared focus token (no new token, no layout/geometry change). Previously a cell reached with the arrow keys only had the UA default affordance.

(b) Validation and Compare “Show row” now announce exactly `Showing <displayKey> in the grid and record inspector` through the existing single polite live region (`edit-live-region`), where `<displayKey>` is the sample's domain display key (`base #12` / `insert #3` from `displayRowKey`) — logical row identity only, never a cell value or filename (ADR 0025). The shared `NavigateToRow` channel takes an optional label; the validation and diff jump handlers pass the display key, and the grid's jump effect lands the roving tab stop (`tabIndex=0`) and DOM focus on the target row instead of leaving focus on the panel button. Failed jumps keep the existing `jumpError` copy and announce nothing. B-side diff samples still offer no jump; no new controls, no key handlers, no telemetry, no engine or grid-protocol change.
