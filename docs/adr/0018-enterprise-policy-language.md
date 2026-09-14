# ADR 0018: Enterprise Policies Use a Declarative, Engine-Neutral Model

## Status

Proposed

## Context

Enterprise governance may require dataset access, row filters, masking, export restrictions, retention, approvals, and AI data-access controls across heterogeneous backends.

## Decision

Define an engine-neutral declarative policy model that can compile to source-native enforcement or gateway enforcement. Every policy exposes its enforcement class: presentation, gateway, or source-native. Evaluate interoperability with Cedar, OPA/Rego, and related policy systems.

## Consequences

This creates auditability and portability, but backend capabilities differ and conflict/precedence semantics require careful design.
