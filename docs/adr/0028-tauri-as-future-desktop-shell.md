# ADR 0028: Tauri Is the Preferred Future Desktop Shell

## Status

Proposed

## Context

Some users may eventually need full filesystem access, native threading, larger memory budgets, secure credential storage, offline enterprise deployment, or native Rust engine integration.

## Decision

If a dedicated desktop application becomes necessary, prefer Tauri with the existing React/Vite UI and Rust-native capabilities. Desktop is not an MVP dependency.

## Consequences

This preserves UI reuse and offers a lighter native shell, while adding platform-specific release/testing complexity.
