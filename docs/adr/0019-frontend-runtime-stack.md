# ADR 0019: React, TypeScript, and Vite for Product Surfaces

## Status
Accepted

## Context

The workbench is primarily a client-side application using WASM, workers, local filesystems, and UI reuse inside a VS Code webview. SSR is not central to the workbench itself.

## Decision

Use TypeScript, React, Vite, pnpm workspaces, and Turborepo for core product surfaces. Prefer headless UI primitives and application-owned styling.

## Consequences

This maximizes iteration speed and Web/VS Code reuse. Separate hosted marketing/admin surfaces may choose a different framework later.
