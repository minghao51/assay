# ADR 0011: Dataset Identity and Versioning Are Logical, Not File-Based

## Status

Accepted

## Context

A dataset may be one file, many partitions, a remote table, or another governed asset. Filename/path identity breaks under rename, repartition, format change, and promotion.

## Decision

Separate stable Dataset identity, immutable DatasetVersion, and one-or-more PhysicalAsset representations. Versions record schema fingerprint, source references, hashes where feasible, row/partition metadata, provenance, and transformation lineage.

## Consequences

This enables reliable diff, review, lineage, and cross-storage evolution. Large-dataset fingerprinting and remote version equivalence require connector-specific strategies.
