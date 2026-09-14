# ADR 0025: Product Telemetry Must Exclude Dataset Contents

## Status

Accepted

## Context

The local-first value proposition depends on trust. Operational telemetry is useful, but dataset values may be proprietary, regulated, or sensitive.

## Decision

Telemetry must not intentionally include row/cell values, query results, secrets, PII, or raw dataset contents. Collect only operational metadata such as operation type, duration, success/failure, format, coarse size buckets, and runtime version. Enterprise deployments support telemetry controls/disablement.

## Consequences

Privacy posture is consistent, though some debugging becomes harder and may require explicit opt-in diagnostic bundles.
