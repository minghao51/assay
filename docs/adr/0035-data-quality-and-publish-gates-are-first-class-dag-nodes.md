# ADR 0035: Validation and Publish Gates Are First-Class Pipeline Semantics

## Status

Accepted

## Context

Data quality and governance should not be separate reports users remember to run after transformations. Trusted data products and Dataset Change Requests require checks to be visible in the pipeline.

## Decision

Support validation and publish-gate semantics directly in the Pipeline IR.

A publish step may require contract success, quality thresholds, privacy checks, policy checks, and review state in governed environments.

```text
Transform -> Validate -> Publish
```

## Consequences

### Positive

- quality is visible in the flow,
- supports non-technical users,
- integrates with DCRs and governance,
- enables CI and enterprise policy enforcement.

### Negative

- execution may stop on validation,
- threshold semantics require careful design,
- local and enterprise enforcement levels differ.
