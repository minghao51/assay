---
'@assay/web': patch
---

fix(ug-7): contain panel and grid failures with recoverable recovery. Every
tool-pane section body (Schema, Editing, Export, History, Validation, Compare,
Filters, SQL, Profile, Pipeline) now has its own `panel` error boundary with
the exact static copy from the UX implementation spec (R-06): a failed section
leaves the grid, pending-changes summary and committed history usable, and
`Try again` remounts only that section without starting a new dataset
session. `Close section` hides the mounted body, focuses the existing nav
link, and reopens the retained fallback without auto-retrying (inner-disclosure
sections use a recovery-only parent override, reset on a new dataset). The
grid fallback now states the exact draft/focus/scroll loss and puts primary
`Try again` (in-place grid reset) before secondary `Reload the workbench`
(fresh session). External SQL requests are acknowledged in App-owned,
session-scoped sequence state before the query is issued, so StrictMode,
boundary retries and close/reopen run zero additional queries for a consumed
sequence, a new sequence runs exactly once, and a stale-session request cannot
run against a replaced dataset. No engine, grid, session-hook or export byte
changes.
