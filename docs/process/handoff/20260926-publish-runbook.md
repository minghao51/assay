# Publish-readiness day — runbook

Authored 2026-09-26. The version cut was **dry-run validated** that day (`pnpm changeset version`
over the full pending set in a throwaway worktree at the then-`main`: clean consumption, valid
semver everywhere, well-formed CHANGELOGs, `workspace:*` ranges untouched, `.changeset/` left
clean; nothing published, worktree discarded — handoff §9 bz). Everything below is executable by
one maintainer + one agent lane; the only hard gate is **M1**.

## Preconditions (all must be ✅ before step 1)

| #   | Gate                                                                        | Where                                     | Status                                                                                         |
| --- | --------------------------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| P1  | **M1: `@assay` org claimed on npm** with the maintainer account (2FA on)    | [manual-actions M1](../manual-actions.md) | ⏳ **THE blocker**                                                                             |
| P2  | npm granular token or logged-in `pnpm login` with publish rights to the org | M1 tail                                   | ⏳ with M1                                                                                     |
| P3  | Org transfer + public-flip decision (repo is private today)                 | manual-actions M2 tail                    | ⏳ **NOT blocking npm publish** — but `--provenance` requires a public repo; note for the flip |
| P4  | M4 trademark/domain                                                         | manual-actions M4                         | ⏳ **NOT blocking npm publish** (G0 branding item)                                             |
| P5  | Six gates green on `main` + remote CI green on the last push                | handoff §2                                | ✅ as of authoring (`f1f74af` + paperwork)                                                     |
| P6  | `pnpm changeset status` matches expectations                                | run it                                    | ✅ 90 pending (10 minor, 1+ patch — re-count on the day)                                       |

## What publishes (ADR 0042 — exactly this set)

`@assay/domain`, `@assay/contracts`, `@assay/validation`, `@assay/diff`, `@assay/grid`,
`@assay/cli` — all currently `0.0.0`, all `private:false`. **Everything else stays private**
(scaffolds, `engine` [D13-pending], `testing`, `engine-duckdb`, `data-sources`, `web`, `vscode`,
`pipeline`, `ai`, `security`, `transforms`): changesets may bump their versions locally
(`privatePackages.version: true`) but `pnpm publish -r` skips them. engine-duckdb keeps its dist
`files`/`publishConfig` so the packed CLI `./node` seam serves dist — it is NOT published.

## Cut sequence (in order; stop on any red)

1. **Version:** `pnpm changeset version` → consumes all pending changesets, rewrites versions +
   CHANGELOGs, empties `.changeset/`. Review `git status` (expect: package.jsons, CHANGELOG.md ×6,
   lockfile specifier-free version refs, `.changeset/` → config only).
2. **Install + commit the cut:** `pnpm install` (lockfile refresh), then ONE commit
   `chore: release — version packages` (or let changesets' Version Packages flow create it).
3. **Full gates on the cut tree:** `pnpm lint` · `pnpm format:check` · `pnpm typecheck` (18) ·
   `pnpm test` · `pnpm build` (9) · `DUCKDB=/tmp/duckdb pnpm test:e2e` ·
   `pnpm exec playwright test tests/e2e/a11y.spec.ts` (dual-scheme scans).
4. **Consumer smoke:** `node apps/cli/scripts/pack-consumer-smoke.mjs` — own-tarball clean-consumer
   plain-node imports of the five libs + installed-bin `profile`/`validate`/`diff` with byte-stable
   JSON and house exit codes (ar-5's reviewer-proven harness).
5. **Push the cut commit; CI must be green** before anything touches the registry.
6. **Publish:** `pnpm -r publish --access public --no-git-checks` from a clean tree at the cut
   commit (pnpm resolves `workspace:*` → real versions at publish; `-r` respects `private`).
   Order is dependency-safe via pnpm's topological run; verify with `npm view @assay/domain version`
   etc. afterwards. 2FA OTP as prompted.
7. **Tag + release:** tag `v<pkg>@<version>` per package (or one `v2026-MM-DD` cut tag — pick ONE
   convention and record it here), push tags, cut GitHub releases from the generated CHANGELOG
   sections.
8. **Post-publish verification:** from a scratch dir outside the repo: `npm i @assay/cli` →
   `assay --version` + a `validate`/`diff`/`profile` run against a fixture (byte-stable, empty
   stderr, house exit codes); `npx` path too. Then: `pnpm changeset status` → clean; check off
   **M1** in [manual-actions](../manual-actions.md); splice the close into `handoff.md` §9.
9. **Follow-ups recorded at ar-5, decide ride-or-defer on the day:** `--provenance` (needs the
   public flip, P3), harness subpath-exports leg, friendlier pack-error message, profile
   src-level determinism pin.

## Abort / rollback

- Before step 6: abort freely — the cut commit is revertible, nothing is public.
- After step 6: npm allows unpublish within 72h for a broken cut (policy: prefer
  `npm deprecate` + a patch cut over unpublish once anything has consumers). Record any incident
  in handoff §9.
- The dry-run can be re-validated any time: throwaway worktree at current `main`, run step 1,
  inspect, discard.

## Status

⏳ **waiting on P1 (M1)** — everything else is agent-side-ready; when M1 lands, one orchestrator
lane executes this runbook with a reviewer verifying steps 4/6/8.
