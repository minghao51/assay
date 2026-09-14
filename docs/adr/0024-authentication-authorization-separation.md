# ADR 0024: Separate Authentication from Authorization

## Status
Accepted

## Context

Identity verification and resource-policy decisions evolve independently and may use different providers.

## Decision

Treat OIDC/OAuth2/SAML/SCIM identity as authentication. Treat resource permissions/policies as authorization. Start with simple RBAC and retain an adapter boundary for Cedar, OpenFGA, OPA, or another policy engine.

## Consequences

This improves enterprise-provider independence but requires careful mapping of authenticated claims into authorization context.
