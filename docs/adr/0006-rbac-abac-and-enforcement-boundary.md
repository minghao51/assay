# ADR 0006: Support RBAC and ABAC with Explicit Enforcement Boundaries

## Status

Accepted

## Context

Enterprise users may require role-based access, contextual policies, row filters, and column masking. UI-only filtering over a local file is not a security boundary.

## Decision

Support RBAC for straightforward permissions and ABAC for contextual policies. Treat row/column security as enforceable only when retrieval is controlled by a source-native policy, governed query service, or Data Workbench gateway.

## Consequences

The UI must distinguish presentation-only masking from enforceable controls. This avoids falsely claiming security where the user already possesses unrestricted file bytes.
