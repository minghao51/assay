# ADR 0013: Define a Small Native Data Contract Format with Adapters

## Status
Proposed

## Context

The product needs portable schema/quality semantics across Web, VS Code, CLI, CI, local engines, and enterprise sources. Existing formats each carry ecosystem-specific assumptions.

## Decision

Define a small canonical Contract AST with a human-readable YAML representation. Support deterministic schema, required/unique, ranges, allowed values, cross-field expressions, quality thresholds, and classifications. Add adapters for compatible subsets of JSON Schema, dbt, Pandera, Great Expectations, and similar systems.

## Consequences

This avoids locking internal semantics to one external framework, but introduces another format and requires careful expression semantics. Arbitrary embedded Python/JavaScript is not allowed.
