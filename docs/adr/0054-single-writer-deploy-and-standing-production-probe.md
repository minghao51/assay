# ADR 0054: One writer to the collector site, and a standing production probe

## Status

Accepted

## Date

2026-11-27

## Deciders

- Maintainer (deployment topology for the collector site; see ADR 0053 for the host choice)

## Context

ADR 0053 put the telemetry collector on Netlify Functions. The site ended up with **two deploy
writers**: the deploy job in `.github/workflows/netlify-collector.yml` (which builds
`netlify/dist/collect.mjs` and uploads it) and Netlify's **Git integration**, which rebuilds `main` on
every push.

The second writer silently undid the first. The site declares no build command, `netlify/dist/` is
git-ignored, and `publish` is a checked-in placeholder — so a Git build published the placeholder with
an **empty functions directory** and became the production deploy. Measured on 2026-11-27:

| Deploy                            | Origin              | Function on `/.netlify/functions/collect` |
| --------------------------------- | ------------------- | ----------------------------------------- |
| `6b096c5a…` 11:41Z                | workflow CLI upload | 405/202 — 8/8 contract probes green       |
| `6b09795d…` 12:36Z                | Git build `fb0dfe7` | 404                                       |
| `6b097d60…` 12:53Z, **published** | Git build `3bbf12c` | 404                                       |

The canonical endpoint answered **404 on `GET`, `OPTIONS` and `POST`** while the workflow's own deploy
was healthy, and two conditions hid it: the deploy job's probe never ran (a URL-parsing defect) and,
even when it does run, it only proves the bytes that run shipped — it cannot see production drifting
45 minutes later. A green Netlify build and a green deploy job were both compatible with a dead
endpoint.

The collector is single-purpose infrastructure: one function, no build graph, no other consumer of
Netlify's Git builds.

## Decision

**The deploy workflow is the only writer to the collector site.** Netlify's Git integration for that
site stays disconnected, and reconnecting it is a decision, not a convenience.

**The workflow probes the canonical production URL on every push to `main`**, in a `verify-production`
job that does not depend on whether that run deployed anything, reading the URL from the repository
variable `ASSAY_COLLECTOR_URL`.

A missing `ASSAY_COLLECTOR_URL` is a job **failure**, never a skip.

Both `netlify.toml` files keep an inert `[build] command` (`pnpm collector:build` at the repository
root, `pnpm -w collector:build` under `base = "netlify"`). `netlify deploy` never executes it; it exists
so that a future reconnect rebuilds the function instead of re-arming the empty-functions trap.

## Consequences

### Positive

- One writer, so there is no race to lose and no way for a push to `main` to unpublish the function.
- "Production serves the collector" becomes a measured claim that is re-checked on every push to `main`,
  instead of a statement about a deploy that happened earlier.
- The failure that motivated this ADR (404 behind a green build) now turns a job red within minutes and
  names its cause, including where to look (the site's deploy history).
- No URL is hardcoded in source and no secret is added: the probe is public HTTP.

### Negative / risks

- Production can lag `main` until a collector-relevant change (or a dispatch) runs the workflow. This is
  harmless for the artefact, which only changes when `netlify/**`, the build/reader scripts or this
  workflow do.
- `main` now depends on a live external service: if the endpoint is down, pushes to `main` are red even
  when the code is fine. That is the intended trade — the alternative was silence — but it means a red
  `main` must be read before it is assumed to be a code failure.
- Two configuration places remain to keep consistent (the repository variable and the site's existence);
  a renamed or recreated site needs `ASSAY_COLLECTOR_URL` updated, and the failure mode is a red
  `verify-production`, not a silent pass.

### Neutral

- The root `netlify.toml` now serves only a reconnect path; it is kept and marked as such, because
  deleting it would leave a reconnect resolving `publish` against a directory that does not exist.
- The deploy job keeps its own post-deploy probe. It answers a different question ("did the bytes this
  run shipped work?") and is kept for that reason.

## Alternatives considered

- **Give the Git build a command and keep both writers** (the first option weighed). It makes the Git
  build correct, but leaves two build paths producing the same artefact and a race between them; the
  single-writer property was the actual defect, so this treats the symptom.
- **Leave the topology and rely on the deploy-time probe.** Rejected: that probe cannot observe drift
  after it runs, which is exactly how the endpoint stayed dead for 72 minutes.
- **Make the standing probe non-blocking (nightly / advisory).** Rejected: a broken production endpoint
  is a correctness failure of this repository's only deployed service, and an advisory signal is the
  class of "green next to broken" this ADR exists to remove. Choosing `workflow_dispatch`-only is a
  smaller version of the same mistake.
