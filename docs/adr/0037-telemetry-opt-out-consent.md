# ADR 0037: Product Telemetry Is Opt-Out

## Status

Accepted

## Context

The roadmap defines privacy-safe product metrics (docs `engineering/04-implementation-plan.md` §15) and ADR 0025 strictly excludes dataset contents, cell values, raw SQL results, secrets, and PII from telemetry. The remaining question was consent posture: opt-in (collect only after explicit action) vs opt-out (collect by default with a visible way to disable).

Pre-launch products need usage signal to validate adoption gates (G2) while preserving the product's local-first privacy story (ADR 0001).

## Decision

Telemetry is **opt-out**: operational metadata is collected by default, with:

1. a first-run disclosure before any collection begins,
2. a visible in-product toggle (web, VS Code, CLI flag `--no-telemetry` / env `DATAWORKBENCH_NO_TELEMETRY`),
3. the exclusions of ADR 0025 unchanged (operational metadata only: operation, format, duration, size bucket, success/failure, feature path),
4. enterprise deployments must support complete telemetry disablement (docs `engineering/06-testing-security-quality.md` §8).

Vendor selection and sampling design remain open (decision D2 tail, due at gate G0).

## Consequences

### Positive

- Adoption gates (G2/G3) get usable signal without nagging users.
- Privacy story stays intact: no dataset contents ever, and disabling is one action.

### Negative / risks

- Default-on collection can be perceived as contradictory to a local-first privacy product; mitigated by the first-run disclosure and easy opt-out.
- Some jurisdictions/package registries require disclosure at install time; the CLI and extension listings must state it.
