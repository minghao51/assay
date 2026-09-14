# ADR 0020: Apache Arrow Is the Primary Tabular Interchange Format

## Status

Accepted

## Context

The product must move tabular data between DuckDB-WASM, JavaScript, Rust/WASM, Parquet tooling, and future DataFusion/native services. JS object arrays are inefficient for large analytical results.

## Decision

Use Apache Arrow as the preferred tabular interchange for query batches, engine-to-UI transport, Rust/JS boundaries, and future remote streaming. Small UI projections may still become ordinary JS values.

## Consequences

This improves columnar efficiency and ecosystem interoperability but requires adapters because Arrow APIs are more complex than plain objects.
