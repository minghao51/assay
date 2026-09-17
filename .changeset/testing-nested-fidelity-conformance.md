---
'@assay/testing': minor
---

feat(m3-1): add nested-data fidelity scenarios to the engine conformance suite — three new scenarios over a subject-declared nested dataset (`nestedDataset` + `stageNestedFile()`, engine-duckdb stages the `fixtures/jsonl/nested.jsonl` golden fixture): `nested-schema-fidelity` pins `schema()`'s full nested type strings (they feed the m1-6 type tree and m3-4's composer), `nested-window-fidelity` proves `fetchRange` delivers values deep-equal across the Arrow IPC worker boundary (structs as records, lists as arrays, NULL preserved at every depth via the exported `normalizeArrowCell` traversal), and `nested-window-clamp` proves >window-size requests clamp honestly (`hasMore` semantics), validated offset windows return exactly their declared slice, and invalid windows still reject with nested columns present. Suite logic unit-tested against the in-memory fake engine; the suite stays engine-agnostic.
