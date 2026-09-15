---
'@assay/testing': patch
---

feat(t1): add the data-engine conformance suite (`engine-conformance`): seven scenarios — lazy boot; open→schema→fetchRange→rowCount→dispose lifecycle; error classes (operation/query/disposed categories); window clamping; Arrow batch shape; corrupt-file open rollback (registry probe); mid-stream error then reuse — parameterized over a structural `EngineConformanceSubject` so every engine implementation runs the same suite without `@assay/testing` importing any engine (docs/engineering/05-repository-structure.md §4). The suite's logic is unit-tested under Node against compliant and deliberately non-compliant fake engines; engines prove themselves by running the scenarios in their own harnesses.
