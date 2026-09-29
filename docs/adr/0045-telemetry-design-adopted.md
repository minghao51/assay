# ADR 0045: Telemetry Design Adopted (Typed Allowlisted Schema, Self-Hosted Collector)

## Status

Accepted (ruling C-pt0-1, 2026-09-29 — the maintainer approved the design with the §11
open-question defaults)

## Date

2026-09-29 (design authored 2026-09-21, `docs/engineering/06-telemetry-design.md`,
reviewer-approved; adopted unchanged)

## Deciders

- Maintainer (ruling C-pt0-1)
- Design authored by the PT-0 launch-readiness queue (pt0-1)

## Context

Gate G0 (public launch) requires adoption evidence without weakening the local-first
privacy story. The vendor/approach call is already decided: self-hosted minimal collector
(D2b, 2026-09-16), opt-out consent (ADR 0037), absolute exclusions (ADR 0025). The
authored design is the complete artifact: a closed allowlist of nine events, a typed
field schema, client-side sampling with volume caps, opt-out mechanics (first-run
disclosure, in-product toggle, `ASSAY_NO_TELEMETRY`, `--no-telemetry`), endpoint
configuration, retention sketch, and per-field privacy arguments with leak drills.

## Decision

Adopt the telemetry design as authored, with its §11 open-question defaults. In
particular, two load-bearing commitments become ADR-level:

1. **The typed schema is the privacy mechanism.** Every telemetry field is a closed
   enum, boolean, bounded integer, or fixed-grammar token (exact-length lowercase hex
   from a CSPRNG). **No field is a free-form string** — the stock, unmodified product
   cannot represent an ADR 0025 exclusion in any field. New fields or events require a
   schema-version change plus a new per-field privacy-table row (design §9).
2. **The event inventory is a closed allowlist.** No surface may emit an event outside
   §2 of the design; adding one is an additive schema change, never a silent extension.

Sampling is client-side before any network work; telemetry never blocks application
paths; with no collector endpoint configured, nothing is constructed, buffered, or sent
(default inert). OQ9 is resolved by this ADR (the typed-schema rule is elevated rather
than left as design-internal red line R2).

## Consequences

### Positive

- G0's telemetry prerequisite moves from designed to implementable; the implementation
  tasks are normal agent work (telemetry queue, 2026-09-29) with the design doc as the
  contract.
- The privacy posture is mechanical, not procedural: reviewers can reject any
  string-typed field by citing this ADR.
- ADR 0025/0037 keep their roles unchanged (exclusions, consent); this ADR binds only
  the schema/collector design.

### Negative

- Two artifacts to keep in sync: the design doc is the detailed contract, this ADR the
  durable commitment — schema evolution must amend both (version bump per design §9).
- The self-hosted collector is an operational responsibility (deployment, retention per
  design §10) that lands on the maintainer, not the repo.

### Neutral

- The collector service itself is out of this repo until a follow-up decision; the repo
  ships the client + endpoint contract, inert by default (OQ5: no server-side
  delete-by-token endpoint in v1).
