# Assay — VS Code Extension (placeholder)

This package is a deliberate placeholder. The VS Code extension is the
**PT-V** track of the post-MVP plan
(`docs/product/04-post-mvp-track.md`) — moved out of the MVP (former
milestone M7) by decision D11, 2026-09-21. The local explorer, query,
nested-data, editing, validation, and diff milestones (M1–M6) are complete;
PT-V starts if selected by open decision D12.

When M7 starts, this package will contain:

- a Custom Editor + Webview for supported dataset formats,
- a workspace filesystem adapter (`@assay/data-sources`),
- Git context integration and a dataset diff command,
- reuse of `@assay/core`, `@assay/ui`, `@assay/grid`
  (ADR 0008),

with the security constraints of `docs/engineering/04-testing-security-quality.md` §6
(minimal filesystem permissions, strict CSP, validated webview messages).
