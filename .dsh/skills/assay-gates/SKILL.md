---
name: assay-gates
description: Run Assay verification gates and report their actual coverage and failures
whenToUse: Before declaring any change done, before opening a PR, or when the user asks to verify the repo
---

# Assay verification gate

Read `AGENTS.md` and `docs/process/handoff.md` first; their scope and operating model win over this skill. For runtime changes, run from a clean isolated worktree in this order, stopping on failure:

1. `pnpm format:check`
2. `pnpm lint`
3. `pnpm typecheck`
4. `pnpm test`
5. `pnpm build`
6. `CI=1 pnpm exec playwright test --retries=0` (fresh servers; use assigned free ports)
7. `pnpm test:coverage`
8. `pnpm docs:links:check`
9. `pnpm adr:index:check`

For telemetry/disclosure changes, also run the isolated configured-build leg and restore endpoint-free stock output exactly as implementation spec §6 describes. Never run stock tests against a configured bundle or send to a real collector. Unset the telemetry endpoint/token/no-telemetry variables for stock checks without printing their values; use the pinned DuckDB CLI and browser setup from the handoff.

A justified docs-only verification subset is permitted by the operating model, but report it as a subset, not a full green gate. These commands do not authorize a push, publication, billing change or deletion of another agent's work.

Rules:

- A package-changing PR must include a `pnpm changeset` record (AGENTS.md § Commands —
  "Record a releasable change (with PRs that change packages)"); none of the gates above creates
  one. Docs-only changes do not need a changeset.
- Never hand-format code to fix lint failures; run `pnpm format` only if the failure is formatting.
- A failure inside `packages/domain` is special: domain src is a dependency-free zone (no external imports, dev deps included).
- Every dataset-shape bug fix must ship a minimal golden fixture + regression test before the gate can pass.
- Report each gate as PASS/FAIL with the failing package and the first actionable error line.
