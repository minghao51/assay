# Telemetry Collector — Operator Contract

**Status:** operator-facing contract (t-3, 2026-09-29; reference deployment added 2026-11-24). The
**client** is shipped in `@assay/telemetry` (t-1: typed schema, sampling, endpoint gate) and wired into
the web app and CLI (t-2: emission, disclosure, opt-out). The **collector service** is specified by this
contract and, since 2026-11-24, has a reference deployment in this repository (§5: one Netlify
Function, adopted by [ADR 0053](../adr/0053-collector-hosted-on-netlify-functions.md)) — that deployment
is **not deployed yet** and this contract is still what a maintainer deploys and operates against
([design](06-telemetry-design.md) OQ5 default: no server-side delete endpoint in v1). It is derived from
[`docs/engineering/06-telemetry-design.md`](06-telemetry-design.md) (§8–§10, Appendix B/C) and
[ADR 0045](../adr/0045-telemetry-design-adopted.md); the design doc wins on conflict.

**Privacy frame ([ADR 0025](../adr/0025-telemetry-and-data-privacy-boundary.md)):** the stock,
unmodified product cannot represent dataset contents, cell values, filenames/paths, SQL text,
contract contents, column names, or PII in any field — every field is a closed enum, a boolean,
a bounded integer, or a fixed-grammar token ([design §3](06-telemetry-design.md)). The collector
must preserve that guarantee: **persist only allowlisted typed fields, drop unknown fields, and
never log or store raw request bodies.**

## 1. Client behaviour (already shipped — for context)

- **Inert by default.** No configured endpoint ⇒ nothing constructed, buffered, or sent; a stock
  build makes zero network calls (design red line R6).
- **Endpoint sources** ([design §8.1](06-telemetry-design.md)): CLI `ASSAY_TELEMETRY_ENDPOINT` /
  `ASSAY_TELEMETRY_TOKEN`; web build-time `ASSAY_TELEMETRY_ENDPOINT` / `ASSAY_TELEMETRY_TOKEN`
  (Vite `define`, no default baked into the source).
- **Timing defaults are per surface** (corrected 2026-11-20): the retry/drop policy is identical on
  both surfaces (see §2), but the CLI ships the design-sketch constants (1.5 s timeout, 200 ms
  backoff base) while the web transport ships 5 s / 250 ms. The table in §2 carries both.
- **Endpoint validation** ([§8.2](06-telemetry-design.md), pinned in
  `packages/telemetry/src/endpoint.ts`): `https` always allowed; `http` only for loopback hosts
  (`localhost`, `127.0.0.1`, `[::1]`); missing/malformed/wrong-scheme/cleartext-non-loopback is
  treated as unconfigured ⇒ inert.
- **Sampling** ([§5](06-telemetry-design.md)) is client-side and applied **before** an event is
  constructed; rates are compiled-in per-mille defaults with build/deploy overrides
  (`ASSAY_TELEMETRY_SAMPLE_<EVENT>`). There is no server-controlled config channel.
- **Opt-out** ([§6](06-telemetry-design.md); [ADR 0037](../adr/0037-telemetry-opt-out-consent.md)):
  `ASSAY_NO_TELEMETRY` (any defined non-empty value, including `0`/`false`) |
  `--no-telemetry` | in-product preference; a first-run disclosure is shown before the first send.
  Opting out emits nothing about the opt-out.

## 2. Wire contract

One HTTP request per batch ([§8.3](06-telemetry-design.md)); the shipped transports are
`apps/cli/src/telemetry/transport.ts` and `apps/web/src/telemetry/transport.ts`.

| Aspect          | Value                                                                                                                                                                                                                                                                        |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Method / path   | `POST` to the configured endpoint (no query string, no credentials in the URL)                                                                                                                                                                                               |
| Headers         | `content-type: application/json`; optional `authorization: Bearer <ASSAY_TELEMETRY_TOKEN>` (write-only ingest token)                                                                                                                                                         |
| Body            | a JSON **array of event objects** (each a §3 envelope + payload); compact JSON                                                                                                                                                                                               |
| Batch bounds    | ≤ **32 events** and ≤ **256 KiB** per request (client splits; excess dropped)                                                                                                                                                                                                |
| Compression     | gzip is optional in the design; the shipped client does not gzip                                                                                                                                                                                                             |
| Client timeout  | **CLI** 1.5 s per attempt (`apps/cli/src/telemetry/transport.ts`, `DEFAULT_TIMEOUT_MS`); **web** 5 s per attempt (`apps/web/src/telemetry/transport.ts`, `DEFAULT_TIMEOUT_MS`)                                                                                               |
| Retries         | 5xx / network / timeout: ≤ **2** retries with exponential backoff, then drop; 4xx: drop, **no retry**; 2xx: accepted. Backoff base: **CLI** 200 ms (waits 200 ms, 400 ms) / **web** 250 ms (waits 250 ms, 500 ms) — `BACKOFF_BASE_MS` in each `*/src/telemetry/transport.ts` |
| Failure posture | every client-side failure is swallowed (R9) — telemetry never blocks or surfaces errors                                                                                                                                                                                      |

### 2.1 Acceptance and validation (collector)

- Reject anything that is not a JSON array of event objects (400; no body echo/logging).
- Validate each event against the **current schema version (`1`)** and the closed nine-event
  allowlist ([design §2/§3](06-telemetry-design.md)):
  `app_boot`, `disclosure_shown`, `dataset_opened`, `dataset_open_failed`, `validation_run`,
  `diff_run`, `profile_run`, `query_run`, `export_run`. **`pipeline_run` must be rejected as an
  unknown event for v1** ([§3.11](06-telemetry-design.md)).
- Validate every field against its declared type/bounds/enum/token grammar; a value outside the
  schema is rejected, never coerced into a free-form store.
- **Drop unknown fields before storage** — never persist and never log them
  ([§9](06-telemetry-design.md), R11). In strict mode you may reject the whole event instead;
  either way no raw body is retained.
- **Unknown major schema versions:** reject with a counter only — never log the body
  ([§9](06-telemetry-design.md)). Support the current and previous major for ≥ one release cycle
  / 90 days during a migration.
- Never write request bodies, headers, or event payloads into operational logs.

### 2.2 Response codes

- `2xx` — batch accepted (the client sends nothing further).
- `4xx` — the client drops the batch without retry (treat as a client/schema bug; do not loop).
- `5xx` / timeout — the client retries up to twice, then drops.

## 3. Storage and retention

Minimum contract ([§10](06-telemetry-design.md)):

| Data                                              | Retention                           | Notes                                                                               |
| ------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------- |
| Raw typed events (allowlisted fields only)        | 90 days, then deleted               | partition by **collector receipt date** — `client_day` is not trusted for retention |
| Daily aggregates (counts/buckets only, no tokens) | 24 months                           | derived after aggregation; no `install_token`/`session_token` retained              |
| Server operational logs                           | ≤ 14 days                           | no request bodies, no event payloads, no IP addresses                               |
| IP addresses                                      | **never persisted**                 | in-memory rate limiting only, dropped immediately                                   |
| Unknown / rejected payloads                       | **never stored or logged**          | reject counter only                                                                 |
| Backups                                           | same or shorter than the raw window | no raw events beyond 90 days in backups                                             |

- `install_token` exists only inside the 90-day raw window; longer-term repeat-usage trends are
  aggregate distinct counts with no token retained. Users break linkage by resetting the local
  install token (no server-side delete-by-token endpoint in v1 — OQ5).
- **Clock skew ([§6.6](06-telemetry-design.md)):** store `client_day` clamped to ±1 day of the
  collector's receipt date (and to the schema bound `[19000, 40000]`), and use the collector's own
  receipt time for retention/aggregation; increment a non-telemetry skew counter for outliers.

## 4. Operational notes

- **Rate limiting** is collector-side and secondary; it never adds events and must not cause a
  field to be persisted that the client would not have sent. The client already downsamples
  (compiled-in rates) and caps buffers (32 events / 256 KiB) and `dataset_opened` at 50/session.
- **No remote configuration.** There is no config-download channel; sampling and schema are
  client-side and versioned.
- **No third-party endpoints/SDKs** — the only egress destination is the configured self-hosted
  collector ([§7 R12](06-telemetry-design.md)).
- **Deployment is a maintainer/G0 tail item** (operator responsibilities: deployment, retention
  enforcement, the public disclosure surface). This repository now ships a _reference deployment_ of
  the collector function (§5) — validation only, no storage — but deploying it, and enforcing the
  retention this contract requires, remain operator work.
- **Verification checklist before going live:** (1) endpoint reachable only over https (or
  loopback http for local dev); (2) ingest token accepted as `Authorization: Bearer …` and never
  logged; (3) a batch with an extra free-form field stores no extra field; (4) `pipeline_run` and
  unknown majors are rejected without body logging; (5) raw-event disposal at 90 days and log
  rotation at 14 days are actually scheduled; (6) no IPs land in any store or log.

## 5. Reference deployment (Netlify Functions)

The host was adopted on 2026-11-24 ([ADR 0053](../adr/0053-collector-hosted-on-netlify-functions.md)):
the collector is a **server endpoint**, so a static host could not work, and one Netlify Function is the
smallest thing that receives the §2 request.

| Artifact        | Path                                                                                       | Role                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Function        | [`netlify/functions/collect.ts`](../../netlify/functions/collect.ts)                       | §2 acceptance: `POST` only, `OPTIONS` preflight, closed value-free reason codes, strict allowlist validation via `@assay/telemetry` |
| Site config     | [`netlify.toml`](../../netlify.toml)                                                       | functions directory, `no-store` header, the endpoint-variable relationship                                                          |
| Deploy workflow | [`.github/workflows/netlify-collector.yml`](../../.github/workflows/netlify-collector.yml) | typecheck/lint/test on every PR and push; deploy from `main` when `netlify/**` or the workflow changes, plus `workflow_dispatch`    |
| Tests           | [`netlify/functions/collect.test.ts`](../../netlify/functions/collect.test.ts)             | acceptance, every refusal category, both batch boundaries, CORS, totality, and value-free logs                                      |

- **Endpoint.** `https://<site>/.netlify/functions/collect`, supplied to the app build as
  `ASSAY_TELEMETRY_ENDPOINT` (§1). Nothing else configures it, so a stock build stays inert; deploy the
  function first, then build the app with that site's URL.
- **Caps.** §2's client bounds are the server's bounds: 32 events, and 256 KiB of events plus a 1 KiB
  array-framing allowance, refused with `400` / `413` before parsing begins.
- **CORS.** Same-origin by default (the site serves the function, so no header is needed); a
  cross-origin caller must be opted into with `ASSAY_TELEMETRY_ALLOWED_ORIGINS`. `*` is never sent.
- **What it does not do.** No storage, no forwarding, no retention job, no rate limiter, no ingest-token
  check: the function validates and discards. §3's retention table and §4's rate limiting therefore
  remain operator work before this endpoint is an analytics source.
- **Status: not deployed.** Remote GitHub Actions is billing-blocked (R-20), so the workflow is
  **unexercised** — no function is deployed and nothing is collected. Creating the Netlify site, adding
  the `NETLIFY_AUTH_TOKEN` / `NETLIFY_SITE_ID` secrets and running the workflow are the remaining human
  step ([successor queue §15.2](../process/handoff/20261121-successor-queue.md)).

## 6. Cross-references

- [Telemetry design](06-telemetry-design.md) — §2 event inventory, §3 typed schema, §5 sampling,
  §6 opt-out, §7 red lines, §8 endpoint/transport, §9 versioning, §10 retention, Appendices A–C.
- [ADR 0025](../adr/0025-telemetry-and-data-privacy-boundary.md) — absolute exclusions.
- [ADR 0037](../adr/0037-telemetry-opt-out-consent.md) — opt-out consent.
- [ADR 0045](../adr/0045-telemetry-design-adopted.md) — typed schema / closed allowlist adopted.
- [Telemetry queue](../process/handoff/20260929-telemetry-queue.md) — t-1 (client core), t-2
  (emission + opt-out/disclosure UX), t-3 (this note).
- Product track: [post-MVP §4](../product/04-post-mvp-track.md) — G0 telemetry prerequisite.
