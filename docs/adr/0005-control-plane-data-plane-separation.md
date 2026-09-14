# ADR 0005: Separate Control Plane and Data Plane

## Status
Accepted

## Context

Enterprise governance requires identity, catalog, contracts, policy, lineage, and audit metadata, while sensitive data may require controlled query execution without exposing unrestricted raw bytes.

## Decision

Separate an enterprise control plane for identity/catalog/policy/audit from a data plane for query execution, connectors, filtering, masking, and streaming results.

## Consequences

The local/free product can remain lightweight while enterprise governance grows independently. This adds service boundaries and deployment complexity only when hosted enterprise capabilities are introduced.
