# ADR 0015: Use Capability-Based Connectors and Plugins

## Status

Proposed

## Context

Sources such as local files, object stores, warehouses, and APIs support different operations. One oversized connector interface would become leaky and misleading.

## Decision

Define connectors through capabilities such as list/read/query/write/snapshot/transactions/nativeRLS/nativeMasking/lineage. Plugins may later contribute data sources, validators, semantic recognizers, renderers, exporters, AI providers, and contract adapters, with explicit permissions.

## Consequences

This avoids lowest-common-denominator APIs and makes security permissions visible. Public third-party plugin marketplace support is deferred until internal connector contracts stabilize.
