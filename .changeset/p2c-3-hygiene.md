---
'@assay/pipeline': patch
'@assay/web': patch
---

chore(p2c-3): shape-valid refusal fixture + stale-comment/changeset-wording touch-ups

Hygiene bundle; no product behavior change.

- **Shape-valid refusal fixture.** `fixtures/pipeline/reserved-namespace-refusal.yaml`'s
  diff node now carries the settled p2-2 `{input, against}` typed table refs (still
  referencing the `base` source), so its `reserved-identifier` refusal is proven to
  fire via the reserved-id short-circuit independent of shape validity — not as a
  side effect of a malformed body. `manifest.json`'s sha256 was regenerated under the
  recursive bidirectional checksum policy, and a new `@assay/pipeline` pin proves the
  document is shape-valid apart from the reserved id (swapping only the id parses and
  DAG-validates).
- **Help-render comment audit.** The pipeline help/usage comments in `apps/cli` were
  audited against current behavior (post-p2-5 gate-visibility, post-p2c-1 verdicts):
  accurate, no change.
- **Changeset wording.** The pending p2-5 changeset's per-node `no-verdict` wording now
  covers the success-path fallthrough as well as the failed-run case.
- **Stale comments.** The two superseded "PROVISIONAL placement" comments
  (`PipelinePanel.tsx`, `pipeline-panel-journey.spec.ts`) now record the q-15 ruling:
  the pipeline panel is a tool-pane resident ordered last (after profile) in both
  layouts.
