# ADR 0001: Local-First Execution by Default

## Status
Accepted

## Context

The product begins as a browser and VS Code dataset workbench. Users may inspect sensitive, proprietary, regulated, or very large datasets. Uploading every file to a backend would create unnecessary privacy, latency, infrastructure-cost, and trust concerns.

## Decision

The default execution model is local-first. For local files, parsing, querying, profiling, validation, diffing, and transformations happen locally unless the user explicitly chooses a remote capability. Remote processing must be explicit and visibly distinguishable from local execution.

## Consequences

This provides a strong privacy story, low infrastructure cost, fast onboarding, and offline capability. Browser resource constraints remain real, and local mode cannot enforce true row-level security over bytes the user already possesses. Local-first is an adoption model, not a prohibition on future hosted or enterprise execution.
