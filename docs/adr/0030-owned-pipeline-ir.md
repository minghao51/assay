# ADR 0030: Data Workbench Owns a Portable Pipeline IR

## Status
Accepted

## Context

SQL alone does not capture node identity, dependencies, validation gates, publish behavior, materialization, lineage, or non-SQL operations.

## Decision

Define a Data Workbench Pipeline IR as the canonical logical pipeline representation.

The IR must be declarative, serializable, engine-neutral, Git-friendly, and usable by Web, VS Code, CLI, and enterprise services.

Initial node classes are source, transform, SQL, validate, diff, and publish.

## Consequences

### Positive

- stable product model,
- multiple execution backends,
- visual and code editing share one representation,
- governance and lineage attach to logical nodes.

### Negative

- schema/version management is required,
- external adapters need translation logic,
- the IR must avoid becoming a proprietary general-purpose workflow language.

## Constraint

The Pipeline IR describes data pipelines and governed data-product workflows, not arbitrary application workflows.
