# ADR 0026: Validation Contracts Compile to Deterministic Execution Plans

## Status
Accepted

## Context

Contract semantics must work across Web, VS Code, CLI, CI, and future remote engines. Binding contracts directly to one library/runtime reduces portability.

## Decision

Parse contracts into a canonical Contract AST and compile rules into deterministic execution plans such as DuckDB SQL, Arrow operations, Ajv/JSON Schema checks, or source-native checks. Core contracts cannot contain arbitrary Python or JavaScript.

## Consequences

This produces portable and auditable validation but requires careful specification of canonical semantics and partial mappings to external frameworks.
