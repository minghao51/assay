---
'@assay/testing': minor
---

feat(m2-5): engine conformance suite gains the `profile-semantics` scenario (10 total): profiles a purpose-built runtime-staged dataset (numeric with a null, duplicate-heavy categoricals, a boolean, a nulls-only column, a DATE, and a pinned count tie) and asserts the full contract — exact rowCount; column names/order; profile type strings agree with `schema()`; per-column kinds match the declared classifier contract with payload presence/absence enforced; exact nullCount/distinctCount; exact numeric min/max/mean/stddev/quantiles (within a declared float tolerance); exact categorical top-k including the declared tie order; unknown-handle profiles reject as a classified engine error with the engine reusable. Subjects declare expectations via a new `profileDataset` field, stage via `stageProfileFile()`, and expose `profile()` on the conformance client surface.
