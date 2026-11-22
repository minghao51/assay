# Telemetry and your privacy

Assay can send a limited set of anonymous usage metadata to a collector operated by the Assay project. Telemetry does not run unless a collector endpoint is configured; the stock source build has no endpoint configured and is inert. When configured, telemetry is on by default unless you opt out.

## What is collected

Each event includes this common envelope: `schema_version` (currently `1`), `event`, `surface` (`web` or `cli`), `install_token` (32 lowercase hexadecimal characters), `session_token` (16 lowercase hexadecimal characters), `client_day` (a bounded day number), and the three bounded integer version components `app_version_major`, `app_version_minor`, and `app_version_patch`. The tokens are generated locally; the install token is a pseudonym and the session token is per process.

The active event allowlist and its event-specific fields are:

| Event                 | Event-specific fields                                                                   |
| --------------------- | --------------------------------------------------------------------------------------- |
| `app_boot`            | `engine_family`, `os_family`, `build_channel`                                           |
| `disclosure_shown`    | `disclosure_revision`                                                                   |
| `dataset_opened`      | `dataset_role`, `format_kind`, `size_bucket`, `row_count_bucket`, `column_count_bucket` |
| `dataset_open_failed` | `dataset_role`, `format_kind`, `reason_code`                                            |
| `validation_run`      | `checks_run`, `finding_count_bucket`, `duration_bucket`, `outcome`                      |
| `diff_run`            | `aspects_count`, `key_mode`, `duration_bucket`, `outcome`                               |
| `profile_run`         | `column_count_bucket`, `duration_bucket`, `outcome`                                     |
| `query_run`           | `query_kind`, `row_count_bucket`, `duration_bucket`, `outcome`                          |
| `export_run`          | `target_format`, `row_count_bucket`, `outcome`                                          |

These event fields are closed enums, bounded integers, or fixed-grammar tokens; there are no free-form text fields. The `pipeline_run` event is reserved and is not active in schema version 1.

## What is never collected

The product telemetry schema excludes dataset contents, cell values, raw SQL results, PII, and sensitive filenames. This privacy boundary is set by [ADR 0025](adr/0025-telemetry-and-data-privacy-boundary.md); the adopted typed schema is specified by [ADR 0045](adr/0045-telemetry-design-adopted.md). No event field accepts arbitrary text.

## Your choice and opt-out

Telemetry is opt-out when configured, as required by [ADR 0037](adr/0037-telemetry-opt-out-consent.md). The first-run disclosure is shown before the first send. These are the implemented copy strings in `packages/telemetry/src/copy.ts` (`WEB_DISCLOSURE_BODY`, `CLI_DISCLOSURE_COPY`, and the web button-label constants):

**Web disclosure body:**

> Help improve Assay — anonymously
>
> Assay is local-first: your data stays on your machine. With your permission, Assay sends a small amount of anonymous usage metadata to a server run by the Assay project.
>
> What is sent: which features you use (for example, "validation ran"), coarse counts and size ranges, how long operations took, and whether they succeeded — plus the app version and your OS family.
>
> What is never sent: your data, cell values, file names or paths, SQL text or query results, contract contents, column names, or anything that identifies you.
>
> Anonymous usage metadata is on by default. Turn it off any time in Settings, or set ASSAY_NO_TELEMETRY=1 before launching Assay. Turning it off stops further attempts and attempts to abort in-flight delivery; metadata already delivered is not recalled.

The web buttons say “Keep anonymous usage on (default)” and “Turn it off”. The CLI shows this notice on stderr once:

> Assay sends anonymous usage metadata by default: which commands you run, coarse counts and durations, success/failure, and the app/engine version. It never sends your data, file names, SQL, or cell values. Disable with ASSAY_NO_TELEMETRY=1 (or `assay --no-telemetry`). This notice is shown once. See docs/engineering/06-telemetry-design.md.

The web Settings toggle is labeled “Anonymous usage metadata”.

Set `ASSAY_NO_TELEMETRY` to any non-empty value (including `0` or `false`) before launching the CLI to disable telemetry. In the web app this variable is read at build time: a non-empty value makes telemetry hard-off in that build, with no runtime override. In both surfaces, the opt-out blocks sends; the web preference takes effect immediately and clears buffered events, and the CLI rechecks opt-out before emitting and flushing. The CLI also accepts `--no-telemetry` for an invocation. On the web, opt out with Settings at any time. These semantics are implemented in `apps/cli/src/telemetry/config.ts`, `apps/cli/src/telemetry/runtime.ts`, `apps/web/src/telemetry/config.ts`, and `apps/web/src/telemetry/runtime.ts`.

## Where data goes

If configured, events are sent off-machine to the self-hosted minimal collector at the configured endpoint. The CLI reads `ASSAY_TELEMETRY_ENDPOINT` at runtime; the web endpoint is supplied at build time through Vite configuration. A missing, empty, or invalid endpoint leaves telemetry inert: nothing is constructed, buffered, or sent. There is no default collector endpoint in the stock source build. See the [collector operator contract](engineering/07-telemetry-collector.md) and [telemetry design](engineering/06-telemetry-design.md). The collector service is not deployed as part of this repository; its deployment remains a G0 launch-readiness tail item ([post-MVP track §4](product/04-post-mvp-track.md#4-pt-0--launch-readiness-the-g0-checklist)).

## Claim → source

| Claim in this disclosure                                                                     | Source to verify                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Common envelope, active event names, per-event fields, reserved event, and typed field forms | `packages/telemetry/src/schema.ts` (`Envelope`, `EVENTS`, payload interfaces, `EVENT_SCHEMAS`, `RESERVED_EVENTS`)                                                                                                         |
| Privacy exclusions / no free-form fields                                                     | [ADR 0025](adr/0025-telemetry-and-data-privacy-boundary.md); `packages/telemetry/src/schema.ts`; [ADR 0045](adr/0045-telemetry-design-adopted.md)                                                                         |
| Exact first-run body and web buttons; CLI disclosure copy                                    | `packages/telemetry/src/copy.ts`; rendering: `apps/web/src/telemetry/TelemetryDisclosure.tsx`, `apps/cli/src/telemetry/runtime.ts`                                                                                        |
| Opt-out requirement                                                                          | [ADR 0037](adr/0037-telemetry-opt-out-consent.md)                                                                                                                                                                         |
| Environment-variable behavior and CLI runtime check                                          | `apps/cli/src/telemetry/config.ts`, `apps/cli/src/telemetry/runtime.ts`, and `apps/cli/src/telemetry/config.test.ts`                                                                                                      |
| Web build-time hard-off and mid-session preference behavior                                  | `apps/web/vite.config.ts`, `apps/web/src/telemetry/config.ts`, `apps/web/src/telemetry/runtime.ts`, and `apps/web/src/telemetry/runtime.test.ts`                                                                          |
| Endpoint sources and inert-without-endpoint behavior                                         | `apps/cli/src/telemetry/config.ts`, `apps/web/src/telemetry/config.ts`, `packages/telemetry/src/endpoint.ts`, [ADR 0045](adr/0045-telemetry-design-adopted.md)                                                            |
| Collector operation and deployment status                                                    | [collector operator contract](engineering/07-telemetry-collector.md); [telemetry design](engineering/06-telemetry-design.md); [post-MVP track §4](product/04-post-mvp-track.md#4-pt-0--launch-readiness-the-g0-checklist) |
