# ADR 0034: Ingestion Is Separate from Transformation

## Status
Accepted

## Context

Reading local files is fundamentally different from extracting data from APIs, SaaS systems, databases, and cloud storage. A transformation runtime should not become a complete connector framework.

## Decision

Model ingestion through Source nodes and DataSource/Connector capabilities. Simple local sources are handled directly. Complex extraction should use connector adapters or external ingestion engines such as dlt where appropriate.

## Consequences

### Positive

- avoids rebuilding connector ecosystems,
- keeps transformation semantics clean,
- enterprise ingestion can evolve independently.

### Negative

- source behavior varies,
- external ingestion introduces deployment dependencies,
- lineage across extraction systems must be normalized.
