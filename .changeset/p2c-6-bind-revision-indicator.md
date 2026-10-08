---
'@assay/web': patch
---

fix(p2c-6): value-free contract bind-revision indicator + e2e re-bind wait. The
pipeline panel's `pipeline-contract-bound` span now carries a value-free
`data-bind-revision` ordinal (component-local, incremented per successful bind)
so a contract _replacement_ is observable without exposing a filename, path, or
contract content (ADR 0025). The e2e `bindContract` helper captures the
revision before picking and waits for it to advance, closing the race where a
re-bind's visible-wait was vacuous and a run could execute against the stale
contract. No rendered text or copy change; attribute only.
