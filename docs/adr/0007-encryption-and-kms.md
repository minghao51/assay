# ADR 0007: Use Standard Encryption and KMS Patterns

## Status
Accepted

## Context

Enterprise use cases may require encryption in transit, at rest, column-specific protection, customer-managed keys, and controlled key access.

## Decision

Use established patterns: TLS, storage encryption, envelope encryption, KMS/Key Vault/Vault integrations, BYOK where required, and Parquet modular encryption where supported. Do not implement custom cryptographic primitives.

## Consequences

Encryption metadata becomes part of dataset governance. Key material and centralized enforcement must remain outside untrusted browser state when enterprise policy requires it.
