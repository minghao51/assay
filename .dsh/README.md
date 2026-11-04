# Optional development skills

This directory contains opt-in instructions for a development-agent harness, not application code or runtime dependencies. Nothing here installs or executes automatically; the HITL script is a template to copy and adapt, not a service to start.

`AGENTS.md`, accepted ADRs, the live [handoff](../docs/process/handoff.md) and its [operating model](../docs/process/handoff/operating-model.md) take precedence. Skills cannot authorize new scope, bypass independent review, weaken gates, publish, push, or modify foreign work. Respect the project's synthetic-data/privacy rules even where a generic example describes another domain.

- `skills/assay-gates/`: full runtime verification and explicit docs-only subset reporting.
- `skills/assay-fixtures/`: deliberate golden fixture regeneration.
- `skills/tdd/` and `skills/diagnosing-bugs/`: adapted third-party guidance; see [provenance and MIT notices](skills/PROVENANCE.md).

The source revision of the original local import was not recorded. Do not infer a pinned upstream snapshot or automatic update policy from its presence here.
