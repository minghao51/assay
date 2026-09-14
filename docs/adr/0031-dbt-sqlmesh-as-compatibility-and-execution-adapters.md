# ADR 0031: dbt and SQLMesh Are Compatibility and Execution Adapters, Not Core Dependencies

## Status

Accepted

## Context

dbt and SQLMesh provide mature SQL transformation ecosystems, but requiring them in the browser/local core would introduce runtime and project-model dependencies that conflict with local-first simplicity.

## Decision

Treat dbt and SQLMesh as integration targets.

Support should evolve toward project inspection, lineage visualization, compatible test/contract mapping, export, and optional execution in suitable environments.

Neither system defines the core Pipeline IR.

## Consequences

### Positive

- ecosystem compatibility,
- no Python/runtime dependency for browser MVP,
- enterprises can retain their existing transformation stacks.

### Negative

- import/export may be partial,
- Jinja/macros and dialect-specific logic complicate translation.

## Compatibility Philosophy

Prefer faithful pass-through for unsupported advanced constructs rather than lossy conversion.
