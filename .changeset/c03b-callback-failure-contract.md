---
'@assay/web': patch
---

fix(c03b): fail closed on session-reset and commit-activation callback faults.

Session reset (`useDatasetSession.beginSession`) now runs every registered reset under its own isolation and returns a value-free `{ token, faults }` outcome instead of throwing. A throwing callback is recorded as `{ index, kind: 'reset-callback' }` (no message, stack, file or value), the remaining callbacks still run, and the token is still bumped first so stale async results stay fenced. `openDataFile`, `cancelOpen` and replacement adoption treat any fault as fail-closed: they never publish `ready`, skip the rest of their guarded chain (adoption skips steps 2–9 including the provider rebind and `dataset_opened`), and render one value-free recovery frame with a reload affordance — never the per-file open-failure copy that hid the cause.

`commitWithRollback` now truly never throws. `setActive(next)`, `setActive(previous)` and both `refresh()` calls are individually contained and the result gains a three-valued `activation` (`applied` | `refused-before-activation` | `rolled-back` | `unknown`), with `restoreFailed` exactly `activation === 'unknown'`. A throwing activation is reported as "the view could not be updated / the previous view has been restored" or, when the restore also fails, as an unknown view with the existing `Retry loading the view` affordance — never as "the previous view is unchanged" and never with the raw fault text. A `setActive` that reports it did not publish can no longer be marketed as applied. R1-C pre-validation refusal, the one-history-entry-per-commit rule, WF-06 session preservation, undo/redo semantics and ADR 0047/0049 retention are unchanged.
