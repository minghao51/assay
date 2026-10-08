---
'@assay/web': patch
---

feat(p2c-4): web panel renders executed-gate verdicts on failed runs

The pipeline panel's failure path now passes each executed gate's value-free
verdict through from `PipelineRunError.partial[].gate` (p2c-1) into the run
outcome — mirroring the success path's `toOutcome` spread. A failed run whose
executed validate/diff/publish gate carries a verdict renders it in the node
list (validate pass + violated-rule count, diff counts, publish
`blockedGates`); partial entries without a verdict render exactly as before
(counts unknown, done). Value-free discipline holds (ADR 0025): verdicts are
counts/classes only, never dataset values or picked file names. No telemetry.
