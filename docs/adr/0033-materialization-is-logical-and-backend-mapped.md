# ADR 0033: Materialization Is a Logical Pipeline Property

## Status

Accepted

## Context

DuckDB, dbt, SQLMesh, and warehouses expose similar persistence concepts through different implementations.

## Decision

Define logical materialization modes in the Pipeline IR:

- ephemeral,
- view,
- table,
- cache,
- incremental,
- export,
- publish.

Execution backends map these logical modes to their own mechanisms.

## Consequences

### Positive

- portable intent,
- easier local-to-production transition,
- clear separation of computation and persistence.

### Negative

- not all backends support every mode,
- mapping semantics must be documented,
- incremental behavior requires more configuration.

Unsupported modes must fail explicitly or request a compatible fallback. Silent semantic changes are not allowed.
