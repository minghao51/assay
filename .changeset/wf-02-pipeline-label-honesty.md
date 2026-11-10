---
'@assay/web': patch
---

fix(wf-02): describe recorded pipeline outcomes as terminal nodes (WFD-08 label-only honesty,
recorded defects D-13/D-14). Three visible strings in the Pipeline panel change and nothing else:
the plan summary now says `N terminal node` / `N terminal nodes` instead of `N output(s)` (the same
`isOutput` set — every node no transform consumes, terminal gate and publish included — so it is
never a count of deliveries, saves or successful artifacts); the terminal-node badge reads
`terminal` instead of `output` (same `isOutput` boolean, same `pipeline-node-output` testid and CSS
class); and the gated run's outcome list is headed `Recorded node outcomes:` instead of
`Completed before the stop:`, because the runner records the gate-blocked node's own outcome before
returning `gated`. Node sets, node statuses, the `isOutput` derivation, the run-outcome model, the
runner, the IR, and all canonical DCR/report bytes are unchanged; `Preview output`, schema and
materialized-relation wording, candidate references and DCR/export copy are byte-identical.
