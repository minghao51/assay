---
'@assay/grid': minor
---

feat(c02a): atomic whole-list filter transactions and a phased failure contract.

`GridDataProvider` gains the **optional** `replaceFilters(specs)` capability: replace the whole ordered predicate list in one all-before-commit operation (`[]` clears, exactly like `filter(null)`), with opaque values kept in the given order and no provider-side metadata on a rejection. Providers that do not implement it keep compiling and keep the documented legacy `filter(null)` + N × `filter(spec)` sequence, which remains **non-atomic** (a mid-sequence rejection is a partial apply) — no breaking, mandatory migration.

`GridViewportModel.setFilters()` becomes the model-owned transaction for that capability (C01 §5.2, R-C01): the whole list is snapshotted and validated before dispatch (a malformed spec still rejects with the plain `TypeError`, zero pushes and no `phase`), the provider operation runs through the existing serialized query queue, a provider-accepted list becomes effective **only together with its refresh**, and overlapping requests reconcile on the **published** list read inside the queue: a superseded accepted run restores that target with exactly one attempt and publishes/refreshes/opens no epoch, and a newer refusal restores the already-published list. A failed restore marks the provider list unknown instead of claiming either list is in effect.

Additive model state: `filtersUnknown` (a restore could not realign the provider) and `reloadError: string | null` (a post-acceptance reload failure; the accepted list stays in effect and recovery is `refresh()`, never a "rejected, nothing changed" claim). One new exported class: `FilterApplyError { phase, cause }` with `name = 'FilterApplyError'` and the value-free phases `refused-before-change` / `accepted-reload-failed` / `restore-failed`; `cause` is the provider's own error unchanged (identity preserved) so existing framing helpers keep working. No new status union, no `GridRowSlot` change, no message parsing, no SQL parsing, and no extra scans per apply — all additive, which is why this is a **minor** bump.

Tests pin the settled C02a assertions (§9.1) and the §6 transition shapes: T1, T2, T3, T4/T5, T6 rapid applies (one provider sequence, one scan), T7/T8/T8b R-C01 reconciliation including the overlap, T9 shared sort/filter ordering, T10 late-page suppression across a failed reload, T12 clear, T13 capability-optional legacy path, plus the `filtersUnknown`/`reloadError` lifecycle, value-free metadata and the package export surface.
