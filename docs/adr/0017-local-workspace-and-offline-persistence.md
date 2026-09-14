# ADR 0017: Local Workspace Metadata Is Portable and Human-Readable

## Status
Accepted

## Context

Local/offline work needs queries, contracts, recipes, profiles, and workspace settings. Storing project semantics only in opaque browser databases would harm portability and Git review.

## Decision

Store portable project semantics under a human-readable `.dataworkbench/` directory where possible. Use OPFS/IndexedDB/VS Code storage for disposable caches, Arrow batches, derived indexes, and other performance state.

## Consequences

Projects remain portable and reviewable, while caches can be rebuilt. Browser filesystem permissions and synchronization conflicts require platform-specific handling.
