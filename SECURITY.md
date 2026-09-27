# Security Policy

Assay is the local-first data workbench: it inspects, validates, compares,
repairs, transforms, and governs structured datasets (Parquet, JSONL, JSON,
CSV, Arrow) inside your own browser or on your own machine. **Your data does
not leave your machine by default.** That local-first promise is why security
reports matter to us: a flaw in Assay can expose the sensitive data you
already hold, not just data in some remote service.

We welcome reports from security researchers. This document explains how to
report, what is in scope, and what you can expect from us.

## Supported versions

Assay is **pre-launch and unreleased**. There are no published releases,
version tags, or package-manager artifacts yet.

| Version              | Supported                                               |
| -------------------- | ------------------------------------------------------- |
| `main` (unreleased)  | Yes — the only supported line; security fixes land here |
| Any released version | N/A — no releases exist                                 |

- Only the tip of `main` is supported. Report against the current `main` and
  include the commit SHA (or latest commit date) you tested.
- There are no older versions, and **no backports**: fixes go to `main`, not
  to branches or tags.
- This table will be revised when the project begins publishing releases.

## Reporting a vulnerability

> **Note (2026-09-23):** GitHub private vulnerability reporting is a
> public-repository feature; this repository is currently **private** (public
> flip is a tracked G0 item), so the button below may not be available yet. In
> that case contact the maintainer privately through the GitHub account
> (`minghao51`) — see `docs/process/manual-actions.md` M2 for the repo-status
> record. Everything else in this section applies unchanged.

**Use GitHub private vulnerability reporting for this repository** — the
primary and preferred channel. On the repository's **Security** tab, choose
**"Report a vulnerability"** to open a private advisory visible only to you
and the maintainers:

<https://github.com/minghao51/assay/security>

Please do **not** open a public issue, discussion, or pull request for a
suspected vulnerability. Private reporting keeps users safe while a fix is
prepared.

### What to include

- A minimal reproduction using a **small synthetic dataset** you can share.
- The affected surface: the web app (`apps/web`), the CLI (`apps/cli`), a
  shared package, or the engine integration (DuckDB-WASM in the browser or
  the Node backend).
- The `main` commit SHA you tested against.
- The impact: what an attacker could do, and what data or boundary is
  crossed.
- Any suggested fix or mitigation (optional, but appreciated).

### What not to include

- **Do not send real, sensitive, proprietary, regulated, or personal data**
  in your report or reproduction. Replace values with synthetic ones. This is
  the same privacy stance Assay itself takes toward datasets
  ([ADR 0025](docs/adr/0025-telemetry-and-data-privacy-boundary.md)).
- Do not include live credentials, tokens, keys, or anything you are not
  authorized to share.
- Redacted and synthetic reproductions are just as useful to us; redact
  freely.

### What to expect

Assay is a community open-source project with a small maintainer team. We
make **no service-level agreement and promise no response time**. We will
make a good-faith effort to acknowledge, triage, and respond to reports.

### Coordinated disclosure

We ask for **coordinated disclosure with a default 90-day window** from the
initial report before you publish details. We are happy to **negotiate this
window** — shorter for low-impact issues, longer if a fix needs more work —
and we will keep you informed of progress. We will credit you in the advisory
if you would like, or keep you anonymous if you prefer.

## Safe harbor

We consider security research conducted in good faith to be authorized, and
we will not pursue or support legal action against researchers who follow
this policy. Good-faith research means:

- You test only against your own copy of Assay or a system you are explicitly
  authorized to test.
- You do not violate anyone's privacy, destroy data, or access, modify, or
  exfiltrate data that is not yours.
- You do not perform denial-of-service, volumetric or resource-exhaustion
  attacks, spam, or social engineering against maintainers, contributors, or
  users.
- You give us a reasonable chance to fix the issue before public disclosure,
  and you report promptly rather than retaining or exploiting the finding.
- You do not exploit the vulnerability beyond the minimum needed to
  demonstrate it.

If a third party's rules or infrastructure are involved, this safe harbor
does not override their terms.

## Scope

### In scope

- The web application (`apps/web`).
- The CLI (`apps/cli`).
- The shared packages in `packages/` (`@assay/*`).
- The engine integration: DuckDB-WASM in the browser and the Node
  `@duckdb/node-api` backend used by the CLI.
- Import and export paths, including two explicit content-handling
  invariants we want researchers to probe:
  - **CSV export is formula-injection-safe** — values that could be
    interpreted as a spreadsheet formula are neutralized, so opening the
    export does not execute them.
  - **Cell values are never executed** — values from datasets are treated as
    untrusted text and must not cause HTML or script execution anywhere in
    the UI.
- This repository's build and release supply chain (dependencies, generated
  artifacts, CI workflows).

### Out of scope

- Third-party hosted services. **None exist yet**: Assay has no backend that
  receives datasets, so there is no hosted service to test.
- Social engineering, phishing, or physical attacks against maintainers or
  contributors.
- Volumetric or resource-exhaustion denial-of-service, and automated scanning
  that degrades shared infrastructure (including GitHub).
- Bugs in builds that are not produced from this repository, or issues that
  cannot be reproduced from a specific `main` commit.
- The `apps/vscode` package: it is a **placeholder** that ships no
  functionality and therefore has no attack surface yet.

## Our commitments

Each of these is a property you can test or hold us to:

1. **Local-first by default.** Local files are parsed, queried, validated,
   diffed, and transformed on your machine; nothing is sent to a server
   unless you explicitly choose a remote capability
   ([ADR 0001](docs/adr/0001-local-first-default.md)).
2. **Dataset values are untrusted content.** Cell values render as text
   only — no HTML or script execution — and CSV exports are neutralized
   against formula injection ([AGENTS.md](AGENTS.md);
   [engineering/04 §5](docs/engineering/04-testing-security-quality.md)).
3. **We never invent cryptographic primitives.** Assay uses established
   patterns — TLS, storage and envelope encryption, KMS, and WebCrypto — and
   does not roll its own cryptography
   ([ADR 0007](docs/adr/0007-encryption-and-kms.md)).
4. **Telemetry policy excludes dataset contents.** Assay's telemetry policy
   forbids row or cell values, raw SQL results, sensitive filenames, and PII;
   only operational metadata is allowed
   ([ADR 0025](docs/adr/0025-telemetry-and-data-privacy-boundary.md);
   [engineering/04 §8](docs/engineering/04-testing-security-quality.md)).
   Telemetry is opt-out, with a first-run disclosure and an in-product toggle
   ([ADR 0037](docs/adr/0037-telemetry-opt-out-consent.md)).
5. **Raw-row access for AI is opt-in** and AI output becomes an explicit,
   reviewable artifact before it is applied — the model never directly mutates
   data ([engineering/04 §4](docs/engineering/04-testing-security-quality.md);
   [ADR 0009](docs/adr/0009-ai-proposes-deterministic-systems-enforce.md)).

## License

Assay is open source under the **AGPL-3.0-or-later** license
([ADR 0036](docs/adr/0036-agpl-license.md)). See
[`LICENSE`](LICENSE).
