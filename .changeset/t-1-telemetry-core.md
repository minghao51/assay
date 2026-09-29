---
'@assay/telemetry': minor
---

feat(t-1): telemetry client core — typed schema + gates (pure module).

New dependency-free package implementing `docs/engineering/06-telemetry-design.md`
§3/§5/§8 (adopted by ADR 0045) as a pure client core:

- the common envelope plus the nine active event payloads as a typed schema that
  makes ADR 0025 exclusions unrepresentable — closed enums, booleans, bounded
  integers, and fixed-grammar CSPRNG tokens only, with a compile-time
  no-free-form-string proof per event shape (`pipeline_run` is reserved and
  rejected as unknown for schema v1);
- one machine-readable descriptor (`ENVELOPE_SCHEMA` / `EVENT_SCHEMAS`) mapped to
  the payload types, driving the total validator and the §4/R10 snapshot;
- `validateEvent`: total (never throws), clamps `client_day`/`checks_run`,
  enforces exact grammars, rejects unknown events/fields without echoing input;
- CSPRNG token helpers (`globalThis.crypto.getRandomValues`), pure bucket
  classifiers, and the §5.1 client-side sampling predicate using platform Web
  Crypto HMAC-SHA256 with compiled-in per-mille defaults;
- `validateEndpoint`/`isTelemetryEnabled` and `createTelemetryCore` — inert by
  default (no valid endpoint ⇒ nothing constructed, sampled, buffered, or sent),
  with no transport, buffer, timer, environment read, or network surface (those
  are the emission-surface tasks' boundary).

Also adds the `packages/telemetry` purity blocks to the root ESLint config,
mirroring `packages/domain` (ADR 0042 build wiring; zero runtime deps).
