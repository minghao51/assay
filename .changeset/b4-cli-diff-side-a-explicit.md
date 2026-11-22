---
'@assay/cli': patch
---

fix(b4): `runDiffPlan` no longer defaults side A to `DATASET_VIEW`. The base view name is a required argument: the `diff` command passes its registered dataset view explicitly and the p2-5 pipeline runner passes its input node relation. The earlier default was the recorded CLI side-A hardcoding — a new caller could bind side A to a view it never chose. Added a Node-path test that registers side A under a different view name and proves the diff is computed over it, plus a value-free refusal when the named base view is absent.
