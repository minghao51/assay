# ADR 0023: Rust and DataFusion for the Future Governed Data Gateway

## Status
Proposed

## Context

Enterprise mode may require a controlled gateway that queries object stores and governed sources while enforcing policies and streaming filtered results. The browser engine should not be stretched into a server architecture.

## Decision

Prototype the future gateway with Rust, Axum, DataFusion, Arrow, `object_store`, and Tokio when a real remote/governed use case requires it. Prefer source-native pushdown when connected systems can enforce/query more effectively.

## Consequences

This fits the Arrow ecosystem and high-throughput execution but adds a second application language and operational surface. Do not build before product demand justifies it.
