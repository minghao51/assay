# ADR 0022: Own a Headless Grid Model and Keep Rendering Replaceable

## Status
Accepted

## Context

The dataset grid must support huge row counts, semantic cells, validation/diff annotations, nested values, accessibility, and editing. A third-party grid should not define product architecture.

## Decision

Own `grid-core` containing viewport, selection, editing, clipboard, navigation, column state, and annotations. Use TanStack Virtual initially and DOM rendering first, while allowing optimized DOM, canvas, hybrid, or third-party renderers later.

## Consequences

Product semantics stay vendor-independent, but interaction/accessibility logic becomes our responsibility.
