# ADR 0003: The Grid Is a View, Not the Dataset

## Status

Accepted

## Context

A naive data-grid implementation can accidentally materialize millions of rows into UI state, coupling rendering to storage and making large datasets unusable.

## Decision

The grid communicates through a GridDataProvider abstraction. It requests visible ranges, nearby rows, schema, sorting, filtering, and mutations. The data engine or source layer owns the dataset. React/UI state must never become the authoritative storage for large row sets.

## Consequences

This preserves scalability and makes remote/gateway-backed datasets possible with the same UI. It requires explicit row identity, careful paging, and more sophisticated selection/editing semantics.
