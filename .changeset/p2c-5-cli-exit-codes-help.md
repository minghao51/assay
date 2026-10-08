---
'@assay/cli': patch
---

fix(p2c-5): global exit-codes help block names pipeline's mapping

The global `exit codes:` block in `assay --help` previously claimed exit 0
meant "no differences found across the aspects that ran" and exit 1 meant
"differences were found" — which misstates `assay pipeline`. The block now
re-scopes its first line from the diff-centric "no differences found across
the aspects that ran" to "the command completed without a failure verdict"
and lists each command's exit-0 semantics (diff: no differences found;
validate: valid; profile: the profile was produced; pipeline run: completed —
even when a diff gate found differences). A diff gate's success is completed
execution, never a "matched" claim. Exit 1 is likewise scoped: "differences
were found (diff), or a pipeline was gated/failed/refused" — results, not
crashes, with the report on stdout. This is consistent with (not a
duplication of) the adjacent pinned `pipeline exit codes:` paragraph, which
still owns the per-subcommand detail. Help-text-only change: the `--help`
byte pins in the CLI integration tests were re-pinned deliberately, with a
new exact-line pin for the global block in `pipeline.integration.test.ts`.
No telemetry.
