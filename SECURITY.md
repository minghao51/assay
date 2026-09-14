# Security Policy

Data Workbench handles datasets that may be sensitive, proprietary, or
regulated. Security and privacy are product features, not add-ons.

## Core commitments

(From `docs/engineering/06-testing-security-quality.md` and ADR 0001/0025.)

1. **Local files stay local by default.** For local files, all parsing,
   querying, profiling, validation, diffing, and transformation happens on the
   user's machine unless the user explicitly chooses a remote capability.
2. **Raw data never enters telemetry.** Operational metadata only (operation,
   format, duration, size bucket, success/failure). No cell values, no raw SQL
   results, no prompts, no identifiers.
3. **UI masking is not security enforcement.** True row/column policies are
   enforced at gateway/source boundaries in governed mode only (ADR 0006).
4. **No custom cryptography.** Standard KMS/TLS/WebCrypto patterns only
   (ADR 0007).
5. **Dataset values are untrusted content** — no HTML/script execution from
   cell values, formula-injection-safe exports, strict CSP on webview surfaces.
6. **AI raw-row access is opt-in and policy-controlled**; AI proposals compile
   to reviewable deterministic artifacts (ADR 0009).

## Reporting a vulnerability

This project is pre-release and does not yet have a public vulnerability
disclosure channel — establishing one is part of launch gate G0
(`docs/product/10-execution-roadmap.md` §5). Until then, contact the
maintainer directly and do not open public issues for security problems.

## Scope

In scope: the web app, VS Code extension, CLI, worker/WASM boundaries, and (in
the future) the control plane and data gateway.
