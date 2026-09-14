# ADR 0027: TypeScript and PostgreSQL for the Initial Hosted Control Plane

## Status

Proposed

## Context

A future hosted control plane is primarily metadata/workflow heavy: organizations, users, workspaces, datasets, contracts, reviews, comments, approvals, and audit metadata.

## Decision

When needed, start with TypeScript, Fastify or Hono, PostgreSQL, and a type-safe query layer such as Kysely/Drizzle. Do not colocate analytical execution in this service.

## Consequences

This maximizes frontend/backend type sharing and development speed but implies a separate Rust data-plane service later if ADR 0023 is adopted.
