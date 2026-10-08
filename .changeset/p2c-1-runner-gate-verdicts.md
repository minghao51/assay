---
'@assay/engine-duckdb': minor
'@assay/cli': minor
---

feat(p2c-1): runner failure payload carries executed gate verdicts

`PipelineRunError.partial` now carries each executed gate's value-free verdict
(`PipelineRunPartialNode.gate` — the same `PipelineRunGateResult` shape a
successful run already carries), so a failed run can honestly report what an
executed validate/diff/publish gate decided before a later node failed. The
field is optional and additive (existing callers that read only
`nodeId`/`relation` compile unchanged); the failing node is never in `partial`
(it never completed), so no verdict is fabricated for it. Value-free discipline
holds: verdicts are counts/classes only (validate valid + violated-rule count,
diff added/removed/changed, publish `blockedGates`), and the error message stays
the fixed value-free class.

`assay pipeline run` renders those verdicts for executed gates in a failed run
(both the human report and the byte-pinned `assay-pipeline-run-report` JSON
envelope) instead of a blanket `no-verdict`. `no-verdict` remains only as the
defensive fallback for a gate result the runner did not carry (the optional
`gate` field is absent); the real runner sets a verdict for every executed gate,
so it is no longer reachable from a real run. This is a versioned
report-envelope shape change under the existing `report` marker /
`reportVersion` discipline (no new marker): a failed run's `nodes[].status` and
`nodes[].gate` now carry the executed gate's real values.
