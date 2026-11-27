# ADR 0053: Collector Hosted on Netlify Functions

## Status

Accepted

## Date

2026-11-24 (host selection ruled by the maintainer; implementation by the collector-deployment
task)

## Deciders

- Maintainer (host adopted: Netlify Functions)
- Collector-deployment implementer (`netlify/functions/collect.ts`, `netlify.toml`, deploy workflow)

## Context

G0 needs a real collector endpoint, and the telemetry arc's last leg was deployment: the design,
the typed schema and the client are shipped ([ADR 0045](0045-telemetry-design-adopted.md)), the
operator contract is written ([`07-telemetry-collector.md`](../engineering/07-telemetry-collector.md)),
and the public disclosure is live ([`telemetry-disclosure.md`](../telemetry-disclosure.md)).

Two facts forced a host decision. (1) The contract describes a **server endpoint**: it receives a
`POST` of a JSON array of events, answers preflights, refuses oversized bodies and validates a
closed allowlist — a static host cannot receive a `POST` at all, so GitHub Pages was never viable.
(2) R-18 deferred the host choice until the product was worth instrumenting, and the successor
queue's option table ([§15.2](../process/handoff/20261121-successor-queue.md)) ranked **Netlify
Functions** first: one function per route, a free tier that covers a minimal collector, and the
endpoint living beside the site.

## Decision

The collector runs as a single Netlify Function, `netlify/functions/collect.ts`, deployed by
`.github/workflows/netlify-collector.yml`; the app is pointed at it with
`ASSAY_TELEMETRY_ENDPOINT=https://<site>/.netlify/functions/collect` at build time. The function
validates every event with `@assay/telemetry`'s own descriptor and closed allowlist — the schema is
**reused, not forked** — and it persists, forwards and logs nothing.

## Consequences

### Positive

- The collector exists as code with tests in this repository, so the contract has an executable
  reference instead of only prose; the schema and its single validation path stay in one place.
- Deployment is a repository workflow, not a bespoke service: reviewable, reproducible, and
  auditable against ADR 0025 (no payload, no value, no address or user agent is logged or stored).
- No third-party endpoint or SDK is introduced; the only egress remains the configured collector.
- Client, schema and public disclosure are unchanged, so this decision adds a host without
  widening what is collected.

### Negative / risks

- **Unexercised.** Remote GitHub Actions is billing-blocked (R-20), so the workflow has never run
  and nothing is deployed; the deploy path is written to be correct, not proven.
- The function stores nothing, so §3's retention table and §4's rate limiting are still operator
  work; until they exist the endpoint is a well-formedness sink, not an analytics source.
- One more runtime in the operational surface (Netlify account, site, secrets), and the CLI version
  used by the deploy step is not yet pinned because no run has established one.
- The ingest token is not verified by this deployment, so `ASSAY_TELEMETRY_TOKEN` is not
  authentication yet.

### Neutral

- The successor queue's R-18 row now records host adoption rather than deferral; its option table
  stays as the record of why.
- Netlify Functions is a hosting choice, not a privacy or schema decision: ADR 0025, ADR 0037 and
  ADR 0045 keep their full authority.

## Alternatives considered

- **Cloudflare Workers** — equally good fit and cheaper at volume, but more configuration for a
  single route; kept as the fallback if Netlify's free tier or ergonomics stop fitting.
- **Fly.io / small VPS** — more control and much more operational surface than one endpoint needs.
- **Static host (GitHub Pages)** — not viable: no server runtime, nowhere to receive a `POST`.

## Amendment (2026-11-24)

The ingest-token sentence above described the first reference deployment, where
`ASSAY_TELEMETRY_TOKEN` was sent by the client and **not** checked. It is now
checked when `ASSAY_TELEMETRY_INGEST_TOKEN` is set on the site: a missing or
mismatched bearer is refused with a value-free `401` **before the body is read
or parsed**, compared with `crypto.timingSafeEqual` over fixed-length hashes.
This is recorded as an amendment rather than a rewrite because the decision did
not change: the token is a **spam filter, not authentication** — anything shipped
to a browser is public.
