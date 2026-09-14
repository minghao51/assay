# ADR 0032: Separate Transformation DAG Semantics from Production Orchestration

## Status

Accepted

## Context

A transformation DAG describes data dependencies and transformations. A production orchestrator additionally handles schedules, retries, sensors, backfills, distributed tasks, notifications, and operational state.

## Decision

Data Workbench owns the logical data pipeline DAG. Scheduling and production orchestration remain separate execution concerns.

Initial execution is local/manual. Future adapters may include dbt, SQLMesh, Dagster, and other orchestrators.

## Consequences

### Positive

- smaller core runtime,
- lightweight local workflows,
- existing orchestration infrastructure can be reused,
- pipeline semantics remain portable.

### Negative

- some users may initially expect scheduling,
- adapter semantics vary by orchestrator.

## Rule

Do not add orchestration concepts to the core Pipeline IR unless they are necessary to describe data semantics rather than operational scheduling.
