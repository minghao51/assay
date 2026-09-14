# ADR 0021: Expensive Local Computation Runs in Workers

## Status
Accepted

## Context

Querying, profiling, validation, hashing, and diffing can be CPU-intensive and would degrade grid responsiveness on the main thread.

## Decision

Run expensive local computation behind Web Worker boundaries using typed application messages or typed RPC. Initial responsibilities include query execution, profiling, validation, and diff/hash.

## Consequences

The UI stays responsive and worker pools can evolve later. Debugging/lifecycle complexity increases, so protocol types must not depend on a specific RPC library.
