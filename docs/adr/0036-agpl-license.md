# ADR 0036: AGPL-3.0-or-later for the Open-Core Repository

## Status

Accepted

## Context

The product uses an open-core commercial model (ADR 0010): the local-first workbench is the free adoption engine, while team collaboration and enterprise governance are paid. The license choice must protect that model while keeping adoption as frictionless as possible.

Options considered:

- **Apache-2.0 / MIT** — maximum adoption and enterprise friendliness, but provides no copyleft protection: a cloud vendor could host the workbench as a service without contributing back.
- **AGPL-3.0** — strong copyleft including network use (SaaS), which is precisely the delivery model we want to protect. Widely used by successful open-core companies (Grafana, Metabase, Plausible).
- **Dual-license (Apache + commercial)** — requires copyright aggregation (CLA) from day one and heavier legal process.
- **SSPL / Elastic License** — rejected: not OSI-approved open source, which conflicts with the positioning of the free tier.

## Decision

The repository (local workbench core: web, VS Code, CLI, shared packages) is licensed under **AGPL-3.0-or-later** (SPDX: `AGPL-3.0-or-later`), see `LICENSE`.

- Hosted team workspaces and enterprise control-plane/data-gateway code may be licensed separately when they arrive (M10/M11); they are not obligated to be AGPL.
- The `or-later` qualifier follows FSF guidance and keeps future-version compatibility; switching to `-only` later would require consent of all copyright holders, so a contributor-agreement decision (CLA/DCO) should accompany any move to accept external contributions at scale.

## Consequences

### Positive

- Cloud providers cannot offer the workbench as a service without releasing their modifications.
- Clear open-source credibility (OSI-approved) with a commercially defensible boundary.
- Compatible with selling commercial licenses for enterprise surfaces.

### Negative / risks

- Some enterprises have blanket AGPL-prohibition policies; mitigated by offering commercial licensing for those use cases.
- Potential corporate contributors may require a contributor agreement before upstreaming; revisit at G2.

## Alternatives considered

See Context. Apache-2.0 remains the fallback if adoption data (gate G2) shows AGPL materially blocking growth.
