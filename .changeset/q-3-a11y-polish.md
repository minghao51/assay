---
'@assay/web': patch
---

fix(q-3): a11y polish pack beyond the pt0-4 axe CI. The export dialog is now a
real modal (`aria-modal`, initial focus, a Tab/Shift+Tab focus trap, Escape to
close, and focus returned to the trigger), and grid edit outcomes share ONE
`aria-live="polite"` region that announces commit success and every value-free
rejection class (client validation reason or the q-8 engine materialization
class) — never a typed draft or a cell value (ADR 0025). The pt0-4 report-only
residue is fixed at the root with the axe allowlist still empty: the grid's
`role="grid"` now lives on a `<div>` (not `<section>`), the actions
`columnheader` carries screen-reader-only text (not just an `aria-label`), and
the profile panel's inner results region has a distinct accessible name. New
e2e pins cover the dialog focus contract, the live-region commit/reject
announcements, and an entirely keyboard-only open → edit → export journey.
