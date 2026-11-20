# Data Workbench Testing, Security, and Quality Strategy

## 1. Quality Goals

The product must remain correct and predictable when handling:

- large datasets,
- malformed files,
- deeply nested records,
- uncommon logical types,
- untrusted content,
- sensitive data.

Correctness is more important than silently “fixing” malformed data.

---

## 2. Test Pyramid

### Unit

Test:

- domain invariants,
- contract parsing,
- edit overlay,
- transform AST,
- diff calculations,
- policy classification.

### Property-Based

Use fast-check / proptest for:

- random schemas,
- nested structures,
- edit sequences,
- serialization round trips,
- parser invariants,
- diff invariants.

### Integration

Test:

- DuckDB-WASM,
- Arrow transport,
- Parquet read/write,
- Web Workers,
- browser filesystem.

### E2E

Use Playwright for:

- open file,
- browse,
- query,
- edit,
- validate,
- diff,
- export.

Which suite proves which **critical contract**, against what subject (fake, real
engine/browser, installed host), with which prerequisites and command, is mapped
in [11-assurance-coverage-map.md](11-assurance-coverage-map.md) — read it before
citing a green suite as assurance for a contract.

### Fuzz

Prioritize:

- JSONL parser surfaces,
- contract parser,
- transform parser,
- Parquet metadata boundaries,
- nested diff.

---

## 3. Golden Fixtures

Each bug involving a specific dataset shape should result in a minimal fixture and regression test.

Fixtures should include:

- malformed JSONL line,
- null-heavy data,
- large cardinality strings,
- nested arrays/structs,
- decimal/logical timestamp cases,
- schema mismatch across partitions,
- duplicate keys,
- non-UTF8/encoding problems where supported,
- large row groups,
- LLM message records,
- tool-call records.

---

## 4. Security Principles

1. Local files stay local by default.
2. Raw data must never enter telemetry.
3. Secrets must never be stored in portable workspace files.
4. UI masking is not equivalent to security enforcement.
5. Remote enterprise policies must be enforced at gateway/source boundaries.
6. Never invent cryptographic primitives.
7. AI raw-row access is opt-in and policy-controlled.
8. Exports are security-sensitive actions and should be auditable in enterprise mode.

---

## 5. Browser Security

Treat loaded dataset values as untrusted content.

Prevent:

- HTML injection,
- formula injection on CSV export,
- unsafe URL rendering,
- script execution from cell values.

Use strict content security policy for VS Code/webview surfaces.

---

## 6. VS Code Security

The extension should:

- minimize filesystem permissions,
- avoid executing project data as code,
- validate webview messages,
- use strict CSP,
- isolate secrets from webview state.

---

## 7. Enterprise Security

Expected future controls:

- OIDC/SAML,
- SCIM,
- RBAC/ABAC,
- audit events,
- TLS,
- KMS/BYOK,
- secret manager integration,
- connector credential isolation,
- policy decision logging,
- export/download policy.

---

## 8. Privacy-Safe Observability

What telemetry may and may not contain is an absolute boundary decided by
[ADR 0025](../adr/0025-telemetry-and-data-privacy-boundary.md) (metadata-only; dataset
contents, query results, secrets, and PII excluded); the consent/opt-out mechanics are
[ADR 0037](../adr/0037-telemetry-opt-out-consent.md). The concrete event schema and privacy
arguments are designed in [engineering/06-telemetry-design.md](06-telemetry-design.md).
Enterprise deployments should support telemetry disablement.

---

## 9. Performance Benchmarks

Maintain repeatable benchmarks for:

- time to first row,
- scroll FPS,
- SQL latency,
- profile latency,
- diff latency,
- export throughput,
- WASM initialization,
- memory usage.

Benchmark dataset sizes:

- 10 MB,
- 100 MB,
- 1 GB,
- 10 GB where streaming/pushdown permits.

---

## 10. Accessibility

Include accessibility in definition-of-done for grid work.

Test:

- keyboard-only use,
- focus order,
- visible focus,
- screen-reader announcements,
- editor overlays,
- high contrast,
- zoom,
- IME input.

A high-performance grid that cannot be operated accessibly is not considered complete.
