---
'@assay/web': patch
---

fix(ug-9): load the run's snapshot contract from the gate-failure cross-link.

A pipeline run now captures its `validate`-node contracts at run start
(`PipelineRunState`'s `gated.contracts`, web-local run state). The gated
detail's "Inspect this contract in Validation" resolves the failed node's
contract from that snapshot instead of the live node binding, so re-binding
the validate node after a failed run can never load a different contract and
misattribute the failure. With no snapshot entry the cross-link is not
offered (no silent fallback).
