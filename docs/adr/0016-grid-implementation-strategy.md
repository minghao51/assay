# ADR 0016: Build a Dataset-Native Grid Layer Incrementally

## Status
Proposed

## Context

Existing grids offer valuable behavior but may not align with long-term performance, accessibility, dataset semantics, or maintenance requirements. Rewriting a production grid before product validation is expensive.

## Decision

Reference/reuse permitted patterns initially, introduce a headless owned grid state layer, then progressively own dataset-specific renderers. Pursue a fully independent grid only if performance, accessibility, licensing, maintainability, or product semantics materially demand it.

## Consequences

This preserves iteration speed and long-term control. Accessibility, IME/CJK input, keyboard behavior, and focus management are first-class constraints rather than later enhancements.
