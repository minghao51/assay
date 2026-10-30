---
'@assay/web': patch
---

fix(web): state profile honesty for staged changes (R-16, ug-10). The Profile
panel now always renders the standing hint "Statistics describe the file as
opened — staged changes are not included." in every expanded state (idle/zero,
running, error, results), and adds a byte-exact staged-changes note while the
active history has at least one operation, counting active entries (not a net
difference) and using singular/plural grammar. Undo back to zero removes the
note while the hint remains. The panel adds no stale/re-run banner, no
re-run-for-edits control and no auto-recompute: `profile(handle)` stays
base-only, with no engine/protocol/domain change and no new telemetry. `App`
passes the active-op count through a new `stagedCount` prop; the existing idle
`profile-table-id` element is untouched.
