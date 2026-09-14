# ADR 0029: SQL Is the Canonical Transformation Target

## Status
Accepted

## Context

Data Workbench needs a transformation model for both visual users and advanced SQL users while remaining portable across DuckDB, databases, warehouses, dbt, and SQLMesh.

## Decision

Use SQL as the canonical execution target for relational transformations. Structured visual operations compile into SQL. Arbitrary SQL is supported through explicit SQL nodes.

## Consequences

### Positive

- broad ecosystem compatibility,
- inspectable and Git-friendly execution,
- local DuckDB support,
- easier dbt/SQLMesh export.

### Negative

- SQL dialect differences require handling,
- non-relational operations need other node types,
- arbitrary SQL cannot always map back to visual blocks.

## Rule

Visual-to-SQL is guaranteed for supported visual operations. SQL-to-visual is best-effort; unsupported SQL remains a Custom SQL node.
