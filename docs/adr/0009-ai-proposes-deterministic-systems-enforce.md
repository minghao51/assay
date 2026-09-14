# ADR 0009: AI Proposes; Deterministic Systems Enforce

## Status
Accepted

## Context

AI is useful for schema mapping, anomaly explanation, repair suggestions, rule generation, and SQL authoring, but opaque direct mutation is difficult to audit and unsafe in governed environments.

## Decision

AI output must become an explicit reviewable artifact before application: a validation rule, mapping, SQL transform, declarative transform, classification, or explanation. Users must be able to preview effects before mutation.

## Consequences

AI remains useful without becoming the source of truth. Generated operations are reproducible, testable, and auditable.
