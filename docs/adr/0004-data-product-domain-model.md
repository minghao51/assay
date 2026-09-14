# ADR 0004: Data Product Is the Primary Domain Concept

## Status

Accepted

## Context

If everything is modeled as a file, future support for remote tables, governed datasets, versions, policies, and multiple physical representations becomes awkward.

## Decision

Center the domain model on DataProduct and Dataset. Files, object-store paths, warehouse tables, and Hugging Face splits are PhysicalAsset instances backing a DatasetVersion.

## Consequences

Governance, contracts, quality, ownership, reviews, and lineage attach to the logical dataset rather than a filename. This enables format/location changes without changing dataset identity.
