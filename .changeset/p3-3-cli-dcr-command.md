---
'@assay/cli': minor
---

New command: `assay dcr <pipeline> --out <path> --base-node <id>
--base-dataset-id <id> --candidate-node <id> --candidate-dataset-id <id>`
(p3-3; ADR 0046 ruling D17-Q5, CLI first). It executes the pipeline on the
local engine (the `assay pipeline run` runner seam) and derives a DCR
artifact v1 off the run through the shared p3-1 builder — the only
construction path: both DatasetVersion references come from the p3-2
`candidateVersionRefFromRun` derivation (logical id, schema fingerprint,
provenance, materialization reference; deterministic default version ids, no
wall-clock), deltas carry the structural schema drift between the two
materialized relations (`@assay/diff`'s own classifier — names and types are
schema, never values), validation carries every validate verdict the run
executed (a gated run carries the verdict that stopped it; verdicts that do
not exist are never fabricated — the p2-5 honesty), and lineage carries the
executed node order. The artifact is written as a NEW file in the canonical
byte-stable YAML form: an existing `--out` path refuses with exit 2 before
anything runs (ADR 0012), and the write itself is an exclusive create. Both
materialization references are verified against the run session at export
time and a dangling reference refuses loudly (typed
`dangling-materialization`, exit 1, nothing written — ruling D19-OQ-5; the
parser side stays dangling-tolerant). Exit codes mirror the pipeline
discipline: 0 written off a completed run; 1 written off a gated run (the
report on stdout discloses the gating) or no artifact off a
failed/refused/canceled run; 2 usage, malformed IR, unresolvable
sources/contracts/gate bindings, a reference derivation that does not match
the run, or the overwrite refusal. The report (`--format human|json`) is
byte-stable and value-free; the seven new flags are dcr-only (other commands
reject them).
