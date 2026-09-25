# Assay — VS Code Extension (placeholder)

This package is a deliberate placeholder. The VS Code extension is milestone
**M7** in the execution roadmap
(`docs/product/03-execution-roadmap.md`), after the local explorer, query,
nested-data, editing, validation, and diff milestones are stable.

When M7 starts, this package will contain:

- a Custom Editor + Webview for supported dataset formats,
- a workspace filesystem adapter (`@dataworkbench/data-sources`),
- Git context integration and a dataset diff command,
- reuse of `@dataworkbench/core`, `@dataworkbench/ui`, `@dataworkbench/grid`
  (ADR 0008),

with the security constraints of `docs/engineering/04-testing-security-quality.md` §6
(minimal filesystem permissions, strict CSP, validated webview messages).
