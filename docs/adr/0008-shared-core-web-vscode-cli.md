# ADR 0008: Share Core Logic Across Web, VS Code, CLI, and CI

## Status
Accepted

## Context

The product is intended to exist across multiple surfaces. Duplicating validation, diff, schema, and transformation semantics would cause behavioral drift.

## Decision

Extract reusable packages for the domain model, engine/source interfaces, validation, diff, transforms, and contracts. Web, VS Code, CLI, and CI are shells around the same core semantics.

## Consequences

This improves consistency and testability, while surface-specific UI/integration code remains isolated.
