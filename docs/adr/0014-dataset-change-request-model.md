# ADR 0014: Dataset Change Request Is the Primary Review Artifact

## Status

Accepted

## Context

Dataset changes are often reviewed through notebooks, screenshots, or ad hoc comparisons. The product needs a first-class semantic review object analogous to a code pull request.

## Decision

Introduce DatasetChangeRequest comparing a base DatasetVersion with a candidate version and capturing schema/row/profile/distribution changes, validation, privacy findings, lineage, evaluations, comments, approvals, and policy checks.

## Consequences

This connects diff, validation, governance, and collaboration and creates a strong team-product primitive. The local tool should still be able to generate a standalone DCR report without hosted services.
