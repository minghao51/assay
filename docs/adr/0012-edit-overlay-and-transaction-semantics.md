# ADR 0012: Use an Edit Overlay with Transaction-Like Semantics

## Status
Accepted

## Context

Parquet and similar analytical formats are not designed for arbitrary in-place row updates. Direct mutation complicates undo, diff, validation, and reproducibility.

## Decision

Represent edits as an overlay over an immutable base: cell updates, inserts, deletes, renames, casts, and schema changes. Users work against a logical view; commit creates a new file/version or explicit transaction on a mutable governed source.

## Consequences

This provides staged changes, preview, undo/redo, validation-before-commit, and clean diffs. Stable row identity is required; temporary positional row numbers are not durable identity.
