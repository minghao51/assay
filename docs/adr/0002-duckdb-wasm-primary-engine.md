# ADR 0002: DuckDB-WASM as the Initial Analytical Engine

## Status

Accepted

## Context

The browser product needs analytical SQL, filtering, joins, profiling, and direct support for Parquet, JSON, and CSV without requiring a backend.

## Decision

Use DuckDB-WASM as the initial analytical engine. Use Apache Arrow as the preferred interchange format between the engine and application. Use parquet-wasm for lower-level Parquet operations where a SQL engine is not the right abstraction.

## Consequences

This provides a mature local analytical runtime and Parquet pushdown, but browser memory/WASM limits remain. Keep DuckDB behind a DataEngine interface so native or remote engines can be added later. DataFusion WASM, Polars WASM, and a custom Rust engine remain alternatives rather than initial dependencies.
