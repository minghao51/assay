---
'@assay/web': minor
---

Group the workbench tools into four user tasks, add a dataset context bar with one explicit next action, return to the findings after a row jump, and make the stale-verdict wording truthful about the session's staged state.

The task strip is a single-select radio group (not tabs) with a task-scoped section link list, so every section stays reachable and the existing close-section focus target is unchanged. Sections remain mounted; the first slice marks the active task's sections rather than hiding the others, and conditional visibility is a separately reviewed follow-up. No engine, session-hook, overlay, export-byte, protocol or dependency change.
