---
'@assay/testing': patch
---

test(t3): add the data-source behavior suite (`data-source-behavior`): six scenarios — identity/idempotency (frozen handle, stable identity, no persistent file identity); one-shot file resolution (lazy, cached snapshot, the additive `getFile` seam); metadata contract (format + exact size only, no engine/content fields); cancel semantics (FSA `AbortError` and input cancel settle `null`, non-abort failures propagate); capability-matrix detection (function-ness, independent members); R5 fallback order — parameterized over a structural `DataSourceBehaviorSubject` so every DataSource adapter runs the same suite without `@assay/testing` importing any implementation (docs/engineering/03-repository-structure.md §4). The suite's logic is unit-tested under Node against compliant and deliberately non-compliant fake sources.
