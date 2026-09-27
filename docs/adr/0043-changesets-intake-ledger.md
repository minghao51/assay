# ADR 0043: Changesets Are the Change-Intake Ledger Until First Publish

## Status

Proposed

## Date

Proposed 2026-09-27

## Deciders

- Maintainer (confirming; drafted by the au2-2 audit-remediation arc)

## Context

The repo has accumulated changesets since M1 (D4: "Changesets for package releases"), but
nothing consumes them yet: every package sits at `0.0.0`, there are no git tags, no release
workflow exists (`.github/workflows/` contains only `ci.yml`), and the first publish is gated
on the npm-org claim (manual action M1) plus the publish-readiness runbook's preconditions.
The 2026-09-27 audit (au2) flagged the ambiguity: ~90 pending changeset files with no defined
consumption point, `private: false` packages with `access: restricted`, and Dependabot lockfile
PRs bypassing the intake entirely. A durable decision is needed so contributors know what a
changeset _is for_ in this phase, and so the eventual first release is a deliberate cut rather
than an accident.

Related: ADR 0036 (AGPL), ADR 0042 (library builds — the artifacts this ledger will version),
`docs/process/handoff/20260926-publish-runbook.md` (the validated cut sequence), D10
(npm-only distribution, resolved).

## Decision

Until the first tagged release, changesets function as the repo's **change-intake ledger**, not
as a versioning mechanism: every PR that changes a package's source or packaging records a
changeset; nothing runs `changeset version` or publishes. The pending set is consumed in one
deliberate consolidation at the M1 publish cut described by the publish runbook (claim the
`@assay` org, un-private the CLI's dependency closure, set `--access public`, run
`changeset version` once, tag, publish). Dependabot lockfile-only bumps record no changeset.
This stance is revisited at the G0 review (or the first externally visible release, whichever
comes first), where a `changesets/action`-based release workflow may replace it.

## Consequences

### Positive

- Contributors keep a single, cheap intake habit now; no tooling to maintain pre-launch.
- The first `changeset version` runs at a deliberate moment with the runbook's smoke checks
  around it, instead of accumulating risk silently.
- No ambiguity about the ~90 pending files or the `access: restricted` default — both are
  explicitly resolved by the cut procedure.

### Negative / risks

- The eventual first version bump is a large, conflict-prone consolidation (mitigated: it is a
  single mechanical run against a green tree, and semver pre-1.0 makes the deltas cosmetic).
- Reviewers must keep enforcing "changeset present if any package changed" by hand until the
  release workflow exists.

### Neutral

- Internal consumers resolve workspace packages as TS source (ADR 0042), so package versions
  carry no operational meaning inside the monorepo today.

## Alternatives considered

- **Wire a release workflow now (`changesets/action`)** — rejected for this phase: nothing is
  publishable until M1 (org claim) and the closure un-privatizing land; a publishing workflow
  that can never succeed is ceremony plus a token-permission surface.
- **Delete changesets until launch** — rejected: the intake habit and per-PR record are cheap
  and already established (D4); rebuilding the ledger at cut time would be worse.
- **Version packages per-PR without publishing** — rejected: `0.0.0`→`0.0.x` churn inside a
  source-resolved workspace adds noise with zero consumer effect.
