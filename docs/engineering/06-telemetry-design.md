# Telemetry Design (D2 tail)

Status: **design-only — not implemented.** This document is the allowlisted telemetry
design for gate G0 (roadmap §5) and closes the D2 design tail (roadmap §7). No
telemetry code, dependency, collector, or network call exists in this repository. Per
checkpoint C-pt0-1 (`docs/process/handoff.md` §6), **no implementation task may be
queued until the maintainer approves this design.**

Related sources of truth (this document does not re-decide them):

- [ADR 0025](../adr/0025-telemetry-and-data-privacy-boundary.md) — absolute exclusions:
  never dataset contents, sensitive filenames, raw SQL results, cell values, or PII.
- [ADR 0037](../adr/0037-telemetry-opt-out-consent.md) — opt-out consent: on by default,
  first-run disclosure, in-product toggle, `ASSAY_NO_TELEMETRY`.
- [ADR 0001](../adr/0001-local-first-default.md) — local-first default; data never leaves the machine.
- [ADR 0039](../adr/0039-product-name-assay.md) — product rename to Assay (the `DATAWORKBENCH_`
  spelling in ADR 0037 maps to the current `ASSAY_` prefix; see §6.1).
- [docs 06 §8](04-testing-security-quality.md) — privacy-safe observability examples.
- [docs 04 §15](02-implementation-plan.md) — product-validation metrics this design serves.
- [roadmap §5/§7](../product/03-execution-roadmap.md) — G0/G2 gates and the D2 decision ledger.
- [post-MVP track §4](../product/04-post-mvp-track.md) — PT-0 launch-readiness checklist item 1.

---

## 1. Purpose and non-goals

### 1.1 Purpose

Provide the **adoption evidence** required by gate G2 without weakening the local-first
privacy story (ADR 0001/0025/0037). Concretely, after approval and a future
implementation, the self-hosted minimal collector (D2b) must make these questions
answerable:

1. **Adoption / repeat usage** — how many distinct installs run the web app and CLI, and
   how often do they come back? (`app_boot` + the pseudonymous `install_token`.)
2. **Feature usage** — are validation and diff actually used, and how often?
   (`validation_run`, `diff_run`; docs 04 §15 "validation usage" / "diff usage".)
3. **Completion and success rates** — file open success rate, failure rate, export/
   transform completion (docs 04 §15). (`dataset_opened` / `dataset_open_failed` /
   `export_run`.)
4. **Performance** — coarse latency distributions for query, profile, validation, and
   diff (docs 04 §15 "median query latency", "profile completion time").
   (`*_run.duration_bucket`.)
5. **Compliance** — proof that the first-run disclosure (ADR 0037) was delivered.
   (`disclosure_shown`.)

This design covers both shipped surfaces: the **web app** (`apps/web`) and the **CLI**
(`apps/cli`, `assay validate` and `assay diff` today). It is written so a third surface
(VS Code / PT-V) can be added additively (see §9) without changing the privacy model.

### 1.2 Non-goals (explicit)

- **Not crash dumps.** No stack traces, exception messages, thread dumps, or minidumps.
- **Not session replay.** No user actions, keystrokes, click paths, timings at
  per-interaction resolution, or DOM/screen state.
- **Not error-log shipping.** Failures are reduced to a closed `reason_code`/`outcome`
  enum. No error text, SQL text, or query strings are ever captured.
- **Not analytics/identifiers.** No user IDs, account IDs, emails, hostnames, usernames,
  IP-derived geolocation, URL/referrer, or raw user-agent. No third-party vendor or SDK.
- **Not configuration telemetry.** Contract contents, rule names, column names, types,
  and `--key` values are never captured.
- **Not remotely configurable.** There is no server-controlled config channel; sampling
  and schema are client-side and versioned.

---

## 2. Event inventory (the complete allowlist)

This is the **entire** set of events any surface may emit. There is no "free-form" or
"send whatever" event, and no event may be added without a schema-version change and a
new §4 privacy-table row (red line R10, §7).

| Event                 | Surfaces      | Trigger                                                             | Why it exists (G2 / docs 04 §15 evidence)                               |
| --------------------- | ------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `app_boot`            | web, cli      | Once per process/boot, after the opt-out and endpoint gates pass    | Adoption denominator, version/engine/OS distribution, repeat usage      |
| `disclosure_shown`    | web, cli      | When the first-run disclosure (§6.3) is actually rendered/shown     | Compliance evidence that ADR 0037's disclosure was delivered            |
| `dataset_opened`      | web, cli      | A dataset is successfully opened/registered for an operation        | File-open success rate; format mix; dataset scale (§15)                 |
| `dataset_open_failed` | web, cli      | Opening/registering a dataset fails (any reason)                    | File-open failure rate; failure triage (§15 "crash/failure rate")       |
| `validation_run`      | web, cli      | A validation run finishes (pass, fail, engine error, or abort)      | "validation usage" (§15); validation latency; G2 feature-evidence       |
| `diff_run`            | web, cli      | A diff run finishes (no differences, differences, error, or abort)  | "diff usage" (§15); diff latency; G2 feature-evidence                   |
| `profile_run`         | web (cli TBD) | A column/dataset profile finishes                                   | "profile completion time" (§15); profiling usage                        |
| `query_run`           | web           | A user/UI query (SQL, filter, sort, nested action, paging) finishes | "median query latency" (§15); query-path adoption                       |
| `export_run`          | web           | An export materialization finishes (incl. refused/cancelled)        | "export/transform completion" (§15); which export formats are used      |
| `pipeline_run`        | _reserved_    | _post-MVP (PT-P), not emitted by any current surface_               | Reserved for pipeline-track adoption; requires a schema bump + new rows |

Surface applicability notes:

- CLI emits `app_boot`, `disclosure_shown`, `dataset_opened`/`dataset_open_failed`
  (validate's primary input; diff's side A and side B), `validation_run`, and `diff_run`.
- `profile_run` is web-only today; the CLI's planned `assay profile` command (see
  `apps/cli/src/index.ts`) may emit it later under the same schema.
- `query_run` and `export_run` have no CLI counterpart today; the CLI's report output is
  not an "export" event.
- `pipeline_run` is listed so the allowlist is complete, but it has **no fields and no
  emitter** until the pipeline track starts; see §3.11.

---

## 3. Typed field schema

**Load-bearing rule:** every telemetry field is one of — a closed enum, a boolean, a
bounded integer, or a fixed-grammar token (lowercase hex of an exact length). **No field
is a free-form string.** If a field cannot hold arbitrary text, it cannot leak text
(§4). Bucket boundaries are part of the schema and may not be changed without a version
bump (§9).

### 3.1 Common envelope (present on every event)

All events carry these fields. The `event` value selects which payload (§3.2–§3.10)
is present.

| Field               | Type                  | Allowed values / bounds                                   | Required |
| ------------------- | --------------------- | --------------------------------------------------------- | -------- |
| `schema_version`    | integer               | exactly `1` (this document's schema)                      | yes      |
| `event`             | enum                  | §2 allowlist (`app_boot` … `pipeline_run`)                | yes      |
| `surface`           | enum                  | `web`, `cli`, `vscode` (reserved — no emitter until PT-V) | yes      |
| `install_token`     | token (fixed grammar) | exactly 32 lowercase hex chars (128-bit CSPRNG)           | yes      |
| `session_token`     | token (fixed grammar) | exactly 16 lowercase hex chars (64-bit CSPRNG)            | yes      |
| `client_day`        | integer               | days since Unix epoch, clamped to `[19000, 40000]`        | yes      |
| `app_version_major` | integer               | `0–999`                                                   | yes      |
| `app_version_minor` | integer               | `0–999`                                                   | yes      |
| `app_version_patch` | integer               | `0–9999`                                                  | yes      |

Notes:

- The app version is decomposed into bounded integers instead of a semver string so no
  field can carry arbitrary text (a deliberate refinement of "surface + version").
  Pre-release/build strings are intentionally not represented.
- `client_day` is the client's coarse date. The collector never trusts it for retention
  or aggregation (see §10) and clamps outliers (§6.6).
- `install_token` and `session_token` are the only string-shaped fields, and both have an
  exact fixed grammar (lowercase hex, fixed length) generated locally from a CSPRNG.
  Neither is derived from hardware, account, dataset, filename, or any user value.

### 3.2 `app_boot`

| Field           | Type | Allowed values / bounds                 | Required |
| --------------- | ---- | --------------------------------------- | -------- |
| `engine_family` | enum | `duckdb_wasm`, `duckdb_node`, `unknown` | yes      |
| `os_family`     | enum | `linux`, `macos`, `windows`, `other`    | yes      |
| `build_channel` | enum | `release`, `dev`, `ci`, `unknown`       | yes      |

`os_family` is parsed from the platform/UA string by the client into a coarse enum; the
raw string is discarded and never sent.

### 3.3 `disclosure_shown`

| Field                 | Type    | Allowed values / bounds | Required |
| --------------------- | ------- | ----------------------- | -------- |
| `disclosure_revision` | integer | `1–999`                 | yes      |

The revision identifies which disclosure copy (§6.3) was shown; it is a small local
constant, not user input.

### 3.4 `dataset_opened`

| Field                 | Type | Allowed values / bounds                                                         | Required |
| --------------------- | ---- | ------------------------------------------------------------------------------- | -------- |
| `dataset_role`        | enum | `primary`, `side_a`, `side_b`                                                   | yes      |
| `format_kind`         | enum | `parquet`, `csv`, `jsonl`, `json`, `arrow`, `unknown`                           | yes      |
| `size_bucket`         | enum | `empty`, `lt_1mb`, `1mb_10mb`, `10mb_100mb`, `100mb_1gb`, `1gb_10gb`, `gt_10gb` | yes      |
| `row_count_bucket`    | enum | `zero`, `1_1k`, `1k_100k`, `100k_1m`, `1m_10m`, `10m_plus`                      | yes      |
| `column_count_bucket` | enum | `zero`, `1_10`, `11_50`, `51_200`, `200_plus`                                   | yes      |

No filename, path, extension, directory, or display name is ever included. `unknown`
format covers anything the sniff/parse step could not classify — it is an enum member,
not a place to put the actual extension.

### 3.5 `dataset_open_failed`

| Field          | Type | Allowed values / bounds                                                                                                                  | Required |
| -------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `dataset_role` | enum | `primary`, `side_a`, `side_b`                                                                                                            | yes      |
| `format_kind`  | enum | `parquet`, `csv`, `jsonl`, `json`, `arrow`, `unknown`                                                                                    | yes      |
| `reason_code`  | enum | `not_found`, `permission_denied`, `unreadable`, `unsupported_format`, `corrupt`, `too_large`, `out_of_memory`, `engine_error`, `unknown` | yes      |

This is the primary leak-drill target: an error classifier MUST map to one of these codes
and MUST NOT attach the error message, SQL, path, or stack. `engine_error` is a class,
not a message.

### 3.6 `validation_run`

| Field                  | Type    | Allowed values / bounds                                            | Required |
| ---------------------- | ------- | ------------------------------------------------------------------ | -------- |
| `checks_run`           | integer | `0–10000` (values above the bound are clamped)                     | yes      |
| `finding_count_bucket` | enum    | `zero`, `1_10`, `11_100`, `101_1k`, `1k_plus`                      | yes      |
| `duration_bucket`      | enum    | `lt_50ms`, `50ms_200ms`, `200ms_1s`, `1s_5s`, `5s_30s`, `30s_plus` | yes      |
| `outcome`              | enum    | `pass`, `fail`, `error`, `aborted`                                 | yes      |

`checks_run` is a count of compiled checks, never rule text, column names, allowed
values, or sample rows. `outcome = fail` carries no verdict detail beyond the bucket.

### 3.7 `diff_run`

| Field             | Type    | Allowed values / bounds                                            | Required |
| ----------------- | ------- | ------------------------------------------------------------------ | -------- |
| `aspects_count`   | integer | `0–4`                                                              | yes      |
| `key_mode`        | enum    | `explicit`, `inferred`, `none`                                     | yes      |
| `duration_bucket` | enum    | `lt_50ms`, `50ms_200ms`, `200ms_1s`, `1s_5s`, `5s_30s`, `30s_plus` | yes      |
| `outcome`         | enum    | `no_differences`, `differences`, `error`, `aborted`                | yes      |

`key_mode` records _how_ keys were chosen, never which columns/values were used. The
actual `--key` column names and inferred candidates are never sent.

### 3.8 `profile_run`

| Field                 | Type | Allowed values / bounds                                            | Required |
| --------------------- | ---- | ------------------------------------------------------------------ | -------- |
| `column_count_bucket` | enum | `zero`, `1_10`, `11_50`, `51_200`, `200_plus`                      | yes      |
| `duration_bucket`     | enum | `lt_50ms`, `50ms_200ms`, `200ms_1s`, `1s_5s`, `5s_30s`, `30s_plus` | yes      |
| `outcome`             | enum | `success`, `error`, `cancelled`                                    | yes      |

No column names, types, top-k values, quantiles, or distribution data are ever sent.

### 3.9 `query_run`

| Field              | Type | Allowed values / bounds                                            | Required |
| ------------------ | ---- | ------------------------------------------------------------------ | -------- |
| `query_kind`       | enum | `user_sql`, `filter`, `sort`, `nested_action`, `paging`, `unknown` | yes      |
| `row_count_bucket` | enum | `zero`, `1_1k`, `1k_100k`, `100k_1m`, `1m_10m`, `10m_plus`         | yes      |
| `duration_bucket`  | enum | `lt_50ms`, `50ms_200ms`, `200ms_1s`, `1s_5s`, `5s_30s`, `30s_plus` | yes      |
| `outcome`          | enum | `success`, `error`, `cancelled`                                    | yes      |

SQL text, filter predicates, sort columns, and result cells are never captured.
`query_kind` is a UI entry-point classification.

### 3.10 `export_run`

| Field              | Type | Allowed values / bounds                                    | Required |
| ------------------ | ---- | ---------------------------------------------------------- | -------- |
| `target_format`    | enum | `parquet`, `csv`, `jsonl`, `json`, `arrow`, `unknown`      | yes      |
| `row_count_bucket` | enum | `zero`, `1_1k`, `1k_100k`, `100k_1m`, `1m_10m`, `10m_plus` | yes      |
| `outcome`          | enum | `success`, `error`, `cancelled`, `refused`                 | yes      |

No destination path, filename, or source name is captured. `refused` covers the
source-overwrite guard and same-entry refusals without revealing the entry.

### 3.11 `pipeline_run` (reserved — no fields)

Not emitted by any current surface (post-MVP, PT-P). Adding it requires an additive
schema change (§9) plus new per-field privacy-table rows before it may be emitted.
Until then, the collector must reject it as an unknown event for the current schema
version.

---

## 4. Per-field privacy table

### 4.1 How to read this table, and the threat model

Every field of every event has a row below. **Envelope fields (§3.1) appear on every
event**, so their rows repeat per event for auditability; the argument is
event-independent. A reviewer re-deriving totals should find:

- 9 envelope fields × 9 active events = 81 envelope rows;
- 30 payload rows across the nine events;
- **111 `(event, field)` rows** in total (the constructed table below).

**Threat model (honesty boundary).** ADR 0025 governs what the _product's designed
telemetry_ intentionally includes; this design defends against accidental inclusion by
construction. Adversarial cases are explicitly out of scope: a user who runs a modified
client can exfiltrate data through any channel they control, and a user can always
encode data numerically in any integer field. What the schema guarantees is that the
**stock, unmodified product cannot represent an ADR 0025 exclusion in any field**, and
that the collector **drops unknown fields rather than persisting them** (§9). The
privacy argument for each row is therefore a provenance + representation argument, not
a claim about a hostile client.

### 4.2 Table

| Event               | Field                | Type / allowed values                                                                                                         | Privacy argument (why this cannot carry an ADR 0025 exclusion)                                                                                                       |
| ------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| app_boot            | schema_version       | integer, exactly `1`                                                                                                          | Fixed schema constant; not derived from data or user input; cannot represent text.                                                                                   |
| app_boot            | event                | enum (§2 allowlist)                                                                                                           | Enum drawn from the fixed allowlist; carries no user-originated value.                                                                                               |
| app_boot            | surface              | enum `web\|cli\|vscode`(reserved)                                                                                             | Build-time surface enum; not user input.                                                                                                                             |
| app_boot            | install_token        | token: exactly 32 lowercase hex (128-bit CSPRNG)                                                                              | Fixed-grammar pseudonym generated locally from a CSPRNG; never derived from hardware, account, dataset, filename, or content; locally resettable. Cannot carry text. |
| app_boot            | session_token        | token: exactly 16 lowercase hex (64-bit CSPRNG)                                                                               | Per-process CSPRNG token, ephemeral, discarded at exit; no derivation from data or user.                                                                             |
| app_boot            | client_day           | integer, clamped `[19000, 40000]`                                                                                             | Coarse system-clock date; a bounded integer cannot encode contents, filenames, SQL, cell values, or PII.                                                             |
| app_boot            | app_version_major    | integer `0–999`                                                                                                               | Bounded integer from build metadata; no free text, so no data path.                                                                                                  |
| app_boot            | app_version_minor    | integer `0–999`                                                                                                               | Bounded integer from build metadata; no free text, so no data path.                                                                                                  |
| app_boot            | app_version_patch    | integer `0–9999`                                                                                                              | Bounded integer from build metadata; no free text, so no data path.                                                                                                  |
| app_boot            | engine_family        | enum `duckdb_wasm\|duckdb_node\|unknown`                                                                                      | Closed enum of engine families; no free text.                                                                                                                        |
| app_boot            | os_family            | enum `linux\|macos\|windows\|other`                                                                                           | Coarse OS enum parsed from the platform/UA string; the raw string is discarded, so no fingerprint detail or data.                                                    |
| app_boot            | build_channel        | enum `release\|dev\|ci\|unknown`                                                                                              | Closed build-channel enum; no free text.                                                                                                                             |
| disclosure_shown    | schema_version       | integer, exactly `1`                                                                                                          | Fixed schema constant; not derived from data or user input; cannot represent text.                                                                                   |
| disclosure_shown    | event                | enum (§2 allowlist)                                                                                                           | Enum drawn from the fixed allowlist; carries no user-originated value.                                                                                               |
| disclosure_shown    | surface              | enum `web\|cli\|vscode`(reserved)                                                                                             | Build-time surface enum; not user input.                                                                                                                             |
| disclosure_shown    | install_token        | token: exactly 32 lowercase hex (128-bit CSPRNG)                                                                              | Fixed-grammar pseudonym generated locally from a CSPRNG; never derived from hardware, account, dataset, filename, or content; locally resettable. Cannot carry text. |
| disclosure_shown    | session_token        | token: exactly 16 lowercase hex (64-bit CSPRNG)                                                                               | Per-process CSPRNG token, ephemeral, discarded at exit; no derivation from data or user.                                                                             |
| disclosure_shown    | client_day           | integer, clamped `[19000, 40000]`                                                                                             | Coarse system-clock date; a bounded integer cannot encode contents, filenames, SQL, cell values, or PII.                                                             |
| disclosure_shown    | app_version_major    | integer `0–999`                                                                                                               | Bounded integer from build metadata; no free text, so no data path.                                                                                                  |
| disclosure_shown    | app_version_minor    | integer `0–999`                                                                                                               | Bounded integer from build metadata; no free text, so no data path.                                                                                                  |
| disclosure_shown    | app_version_patch    | integer `0–9999`                                                                                                              | Bounded integer from build metadata; no free text, so no data path.                                                                                                  |
| disclosure_shown    | disclosure_revision  | integer `1–999`                                                                                                               | Small local constant identifying the copy revision; cannot hold text or data.                                                                                        |
| dataset_opened      | schema_version       | integer, exactly `1`                                                                                                          | Fixed schema constant; not derived from data or user input; cannot represent text.                                                                                   |
| dataset_opened      | event                | enum (§2 allowlist)                                                                                                           | Enum drawn from the fixed allowlist; carries no user-originated value.                                                                                               |
| dataset_opened      | surface              | enum `web\|cli\|vscode`(reserved)                                                                                             | Build-time surface enum; not user input.                                                                                                                             |
| dataset_opened      | install_token        | token: exactly 32 lowercase hex (128-bit CSPRNG)                                                                              | Fixed-grammar pseudonym generated locally from a CSPRNG; never derived from hardware, account, dataset, filename, or content; locally resettable. Cannot carry text. |
| dataset_opened      | session_token        | token: exactly 16 lowercase hex (64-bit CSPRNG)                                                                               | Per-process CSPRNG token, ephemeral, discarded at exit; no derivation from data or user.                                                                             |
| dataset_opened      | client_day           | integer, clamped `[19000, 40000]`                                                                                             | Coarse system-clock date; a bounded integer cannot encode contents, filenames, SQL, cell values, or PII.                                                             |
| dataset_opened      | app_version_major    | integer `0–999`                                                                                                               | Bounded integer from build metadata; no free text, so no data path.                                                                                                  |
| dataset_opened      | app_version_minor    | integer `0–999`                                                                                                               | Bounded integer from build metadata; no free text, so no data path.                                                                                                  |
| dataset_opened      | app_version_patch    | integer `0–9999`                                                                                                              | Bounded integer from build metadata; no free text, so no data path.                                                                                                  |
| dataset_opened      | dataset_role         | enum `primary\|side_a\|side_b`                                                                                                | Describes the slot, not the file; cannot carry a filename.                                                                                                           |
| dataset_opened      | format_kind          | enum `parquet\|csv\|jsonl\|json\|arrow\|unknown`                                                                              | Closed format enum; an unrecognized file maps to `unknown`, so no extension or name is carried.                                                                      |
| dataset_opened      | size_bucket          | enum `empty\|lt_1mb\|1mb_10mb\|10mb_100mb\|100mb_1gb\|1gb_10gb\|gt_10gb`                                                      | Coarse byte-range enum, lossy by construction; cannot encode contents                                                                                                |
| dataset_opened      | row_count_bucket     | enum `zero\|1_1k\|1k_100k\|100k_1m\|1m_10m\|10m_plus`                                                                         | Coarse row-range enum; cannot encode cell values.                                                                                                                    |
| dataset_opened      | column_count_bucket  | enum `zero\|1_10\|11_50\|51_200\|200_plus`                                                                                    | Coarse column-range enum; cannot encode column names or values.                                                                                                      |
| dataset_open_failed | schema_version       | integer, exactly `1`                                                                                                          | Fixed schema constant; not derived from data or user input; cannot represent text.                                                                                   |
| dataset_open_failed | event                | enum (§2 allowlist)                                                                                                           | Enum drawn from the fixed allowlist; carries no user-originated value.                                                                                               |
| dataset_open_failed | surface              | enum `web\|cli\|vscode`(reserved)                                                                                             | Build-time surface enum; not user input.                                                                                                                             |
| dataset_open_failed | install_token        | token: exactly 32 lowercase hex (128-bit CSPRNG)                                                                              | Fixed-grammar pseudonym generated locally from a CSPRNG; never derived from hardware, account, dataset, filename, or content; locally resettable. Cannot carry text. |
| dataset_open_failed | session_token        | token: exactly 16 lowercase hex (64-bit CSPRNG)                                                                               | Per-process CSPRNG token, ephemeral, discarded at exit; no derivation from data or user.                                                                             |
| dataset_open_failed | client_day           | integer, clamped `[19000, 40000]`                                                                                             | Coarse system-clock date; a bounded integer cannot encode contents, filenames, SQL, cell values, or PII.                                                             |
| dataset_open_failed | app_version_major    | integer `0–999`                                                                                                               | Bounded integer from build metadata; no free text, so no data path.                                                                                                  |
| dataset_open_failed | app_version_minor    | integer `0–999`                                                                                                               | Bounded integer from build metadata; no free text, so no data path.                                                                                                  |
| dataset_open_failed | app_version_patch    | integer `0–9999`                                                                                                              | Bounded integer from build metadata; no free text, so no data path.                                                                                                  |
| dataset_open_failed | dataset_role         | enum `primary\|side_a\|side_b`                                                                                                | Describes the slot, not the file; cannot carry a filename.                                                                                                           |
| dataset_open_failed | format_kind          | enum `parquet\|csv\|jsonl\|json\|arrow\|unknown`                                                                              | Closed format enum; no extension or name is carried.                                                                                                                 |
| dataset_open_failed | reason_code          | enum `not_found\|permission_denied\|unreadable\|unsupported_format\|corrupt\|too_large\|out_of_memory\|engine_error\|unknown` | Closed failure-class enum; the error message, SQL, path, and stack are never captured — the classifier maps to a code only.                                          |
| validation_run      | schema_version       | integer, exactly `1`                                                                                                          | Fixed schema constant; not derived from data or user input; cannot represent text.                                                                                   |
| validation_run      | event                | enum (§2 allowlist)                                                                                                           | Enum drawn from the fixed allowlist; carries no user-originated value.                                                                                               |
| validation_run      | surface              | enum `web\|cli\|vscode`(reserved)                                                                                             | Build-time surface enum; not user input.                                                                                                                             |
| validation_run      | install_token        | token: exactly 32 lowercase hex (128-bit CSPRNG)                                                                              | Fixed-grammar pseudonym generated locally from a CSPRNG; never derived from hardware, account, dataset, filename, or content; locally resettable. Cannot carry text. |
| validation_run      | session_token        | token: exactly 16 lowercase hex (64-bit CSPRNG)                                                                               | Per-process CSPRNG token, ephemeral, discarded at exit; no derivation from data or user.                                                                             |
| validation_run      | client_day           | integer, clamped `[19000, 40000]`                                                                                             | Coarse system-clock date; a bounded integer cannot encode contents, filenames, SQL, cell values, or PII.                                                             |
| validation_run      | app_version_major    | integer `0–999`                                                                                                               | Bounded integer from build metadata; no free text, so no data path.                                                                                                  |
| validation_run      | app_version_minor    | integer `0–999`                                                                                                               | Bounded integer from build metadata; no free text, so no data path.                                                                                                  |
| validation_run      | app_version_patch    | integer `0–9999`                                                                                                              | Bounded integer from build metadata; no free text, so no data path.                                                                                                  |
| validation_run      | checks_run           | integer `0–10000` (clamped)                                                                                                   | Count of compiled checks, never rule text, column names, allowed values, or sample rows.                                                                             |
| validation_run      | finding_count_bucket | enum `zero\|1_10\|11_100\|101_1k\|1k_plus`                                                                                    | Coarse finding-count enum; row identities and cell values are never sent.                                                                                            |
| validation_run      | duration_bucket      | enum `lt_50ms\|50ms_200ms\|200ms_1s\|1s_5s\|5s_30s\|30s_plus`                                                                 | Coarse wall-clock enum; a bucket cannot encode contents.                                                                                                             |
| validation_run      | outcome              | enum `pass\|fail\|error\|aborted`                                                                                             | Closed outcome enum; no message or verdict detail.                                                                                                                   |
| diff_run            | schema_version       | integer, exactly `1`                                                                                                          | Fixed schema constant; not derived from data or user input; cannot represent text.                                                                                   |
| diff_run            | event                | enum (§2 allowlist)                                                                                                           | Enum drawn from the fixed allowlist; carries no user-originated value.                                                                                               |
| diff_run            | surface              | enum `web\|cli\|vscode`(reserved)                                                                                             | Build-time surface enum; not user input.                                                                                                                             |
| diff_run            | install_token        | token: exactly 32 lowercase hex (128-bit CSPRNG)                                                                              | Fixed-grammar pseudonym generated locally from a CSPRNG; never derived from hardware, account, dataset, filename, or content; locally resettable. Cannot carry text. |
| diff_run            | session_token        | token: exactly 16 lowercase hex (64-bit CSPRNG)                                                                               | Per-process CSPRNG token, ephemeral, discarded at exit; no derivation from data or user.                                                                             |
| diff_run            | client_day           | integer, clamped `[19000, 40000]`                                                                                             | Coarse system-clock date; a bounded integer cannot encode contents, filenames, SQL, cell values, or PII.                                                             |
| diff_run            | app_version_major    | integer `0–999`                                                                                                               | Bounded integer from build metadata; no free text, so no data path.                                                                                                  |
| diff_run            | app_version_minor    | integer `0–999`                                                                                                               | Bounded integer from build metadata; no free text, so no data path.                                                                                                  |
| diff_run            | app_version_patch    | integer `0–9999`                                                                                                              | Bounded integer from build metadata; no free text, so no data path.                                                                                                  |
| diff_run            | aspects_count        | integer `0–4`                                                                                                                 | Count of aspects computed, not aspect payloads; cannot carry data.                                                                                                   |
| diff_run            | key_mode             | enum `explicit\|inferred\|none`                                                                                               | How keys were chosen; actual key column names and inferred candidates are never sent.                                                                                |
| diff_run            | duration_bucket      | enum `lt_50ms\|50ms_200ms\|200ms_1s\|1s_5s\|5s_30s\|30s_plus`                                                                 | Coarse wall-clock enum; a bucket cannot encode contents.                                                                                                             |
| diff_run            | outcome              | enum `no_differences\|differences\|error\|aborted`                                                                            | Closed outcome enum; no diff values or row keys are sent.                                                                                                            |
| profile_run         | schema_version       | integer, exactly `1`                                                                                                          | Fixed schema constant; not derived from data or user input; cannot represent text.                                                                                   |
| profile_run         | event                | enum (§2 allowlist)                                                                                                           | Enum drawn from the fixed allowlist; carries no user-originated value.                                                                                               |
| profile_run         | surface              | enum `web\|cli\|vscode`(reserved)                                                                                             | Build-time surface enum; not user input.                                                                                                                             |
| profile_run         | install_token        | token: exactly 32 lowercase hex (128-bit CSPRNG)                                                                              | Fixed-grammar pseudonym generated locally from a CSPRNG; never derived from hardware, account, dataset, filename, or content; locally resettable. Cannot carry text. |
| profile_run         | session_token        | token: exactly 16 lowercase hex (64-bit CSPRNG)                                                                               | Per-process CSPRNG token, ephemeral, discarded at exit; no derivation from data or user.                                                                             |
| profile_run         | client_day           | integer, clamped `[19000, 40000]`                                                                                             | Coarse system-clock date; a bounded integer cannot encode contents, filenames, SQL, cell values, or PII.                                                             |
| profile_run         | app_version_major    | integer `0–999`                                                                                                               | Bounded integer from build metadata; no free text, so no data path.                                                                                                  |
| profile_run         | app_version_minor    | integer `0–999`                                                                                                               | Bounded integer from build metadata; no free text, so no data path.                                                                                                  |
| profile_run         | app_version_patch    | integer `0–9999`                                                                                                              | Bounded integer from build metadata; no free text, so no data path.                                                                                                  |
| profile_run         | column_count_bucket  | enum `zero\|1_10\|11_50\|51_200\|200_plus`                                                                                    | Coarse column-range enum; column names/types and statistics are never sent.                                                                                          |
| profile_run         | duration_bucket      | enum `lt_50ms\|50ms_200ms\|200ms_1s\|1s_5s\|5s_30s\|30s_plus`                                                                 | Coarse wall-clock enum; a bucket cannot encode contents.                                                                                                             |
| profile_run         | outcome              | enum `success\|error\|cancelled`                                                                                              | Closed outcome enum; no message or values.                                                                                                                           |
| query_run           | schema_version       | integer, exactly `1`                                                                                                          | Fixed schema constant; not derived from data or user input; cannot represent text.                                                                                   |
| query_run           | event                | enum (§2 allowlist)                                                                                                           | Enum drawn from the fixed allowlist; carries no user-originated value.                                                                                               |
| query_run           | surface              | enum `web\|cli\|vscode`(reserved)                                                                                             | Build-time surface enum; not user input.                                                                                                                             |
| query_run           | install_token        | token: exactly 32 lowercase hex (128-bit CSPRNG)                                                                              | Fixed-grammar pseudonym generated locally from a CSPRNG; never derived from hardware, account, dataset, filename, or content; locally resettable. Cannot carry text. |
| query_run           | session_token        | token: exactly 16 lowercase hex (64-bit CSPRNG)                                                                               | Per-process CSPRNG token, ephemeral, discarded at exit; no derivation from data or user.                                                                             |
| query_run           | client_day           | integer, clamped `[19000, 40000]`                                                                                             | Coarse system-clock date; a bounded integer cannot encode contents, filenames, SQL, cell values, or PII.                                                             |
| query_run           | app_version_major    | integer `0–999`                                                                                                               | Bounded integer from build metadata; no free text, so no data path.                                                                                                  |
| query_run           | app_version_minor    | integer `0–999`                                                                                                               | Bounded integer from build metadata; no free text, so no data path.                                                                                                  |
| query_run           | app_version_patch    | integer `0–9999`                                                                                                              | Bounded integer from build metadata; no free text, so no data path.                                                                                                  |
| query_run           | query_kind           | enum `user_sql\|filter\|sort\|nested_action\|paging\|unknown`                                                                 | UI entry-point classification; SQL text, predicates, and sort columns are never captured.                                                                            |
| query_run           | row_count_bucket     | enum `zero\|1_1k\|1k_100k\|100k_1m\|1m_10m\|10m_plus`                                                                         | Coarse result-count enum; result values are never sent.                                                                                                              |
| query_run           | duration_bucket      | enum `lt_50ms\|50ms_200ms\|200ms_1s\|1s_5s\|5s_30s\|30s_plus`                                                                 | Coarse wall-clock enum; a bucket cannot encode contents.                                                                                                             |
| query_run           | outcome              | enum `success\|error\|cancelled`                                                                                              | Closed outcome enum; no SQL text or result data.                                                                                                                     |
| export_run          | schema_version       | integer, exactly `1`                                                                                                          | Fixed schema constant; not derived from data or user input; cannot represent text.                                                                                   |
| export_run          | event                | enum (§2 allowlist)                                                                                                           | Enum drawn from the fixed allowlist; carries no user-originated value.                                                                                               |
| export_run          | surface              | enum `web\|cli\|vscode`(reserved)                                                                                             | Build-time surface enum; not user input.                                                                                                                             |
| export_run          | install_token        | token: exactly 32 lowercase hex (128-bit CSPRNG)                                                                              | Fixed-grammar pseudonym generated locally from a CSPRNG; never derived from hardware, account, dataset, filename, or content; locally resettable. Cannot carry text. |
| export_run          | session_token        | token: exactly 16 lowercase hex (64-bit CSPRNG)                                                                               | Per-process CSPRNG token, ephemeral, discarded at exit; no derivation from data or user.                                                                             |
| export_run          | client_day           | integer, clamped `[19000, 40000]`                                                                                             | Coarse system-clock date; a bounded integer cannot encode contents, filenames, SQL, cell values, or PII.                                                             |
| export_run          | app_version_major    | integer `0–999`                                                                                                               | Bounded integer from build metadata; no free text, so no data path.                                                                                                  |
| export_run          | app_version_minor    | integer `0–999`                                                                                                               | Bounded integer from build metadata; no free text, so no data path.                                                                                                  |
| export_run          | app_version_patch    | integer `0–9999`                                                                                                              | Bounded integer from build metadata; no free text, so no data path.                                                                                                  |
| export_run          | target_format        | enum `parquet\|csv\|jsonl\|json\|arrow\|unknown`                                                                              | Closed format enum; no destination path or filename is captured.                                                                                                     |
| export_run          | row_count_bucket     | enum `zero\|1_1k\|1k_100k\|100k_1m\|1m_10m\|10m_plus`                                                                         | Coarse row-count enum; exported cell values are never sent.                                                                                                          |
| export_run          | outcome              | enum `success\|error\|cancelled\|refused`                                                                                     | Closed outcome enum; refusal reasons map to a code, never the entry/path.                                                                                            |

---

## 5. Sampling design

Sampling exists to bound volume and cost without meaningfully biasing the G2 signals.
Rates are applied **client-side before any network work**, so an unsampled event is never
constructed, buffered, or sent. All rates are per-mille, compiled-in defaults, and
override-able by build/deploy configuration (never by a remote server — see §5.3).

| Event                 | Default rate | Always-send exceptions                                    | Rationale                                                        |
| --------------------- | ------------ | --------------------------------------------------------- | ---------------------------------------------------------------- |
| `app_boot`            | 1000‰ (100%) | —                                                         | Low volume; the adoption denominator must be complete            |
| `disclosure_shown`    | 1000‰ (100%) | —                                                         | Compliance evidence; one per install                             |
| `dataset_opened`      | 1000‰ (100%) | — (capped at 50 per session, then dropped)                | Open success-rate denominators matter; cap bounds runaway opens  |
| `dataset_open_failed` | 1000‰ (100%) | —                                                         | Failures are rare and high-value; never sample failures          |
| `validation_run`      | 1000‰ (100%) | —                                                         | G2-critical feature evidence; low volume                         |
| `diff_run`            | 1000‰ (100%) | —                                                         | G2-critical feature evidence; low volume                         |
| `export_run`          | 1000‰ (100%) | —                                                         | Completion metric; moderate volume                               |
| `profile_run`         | 250‰ (25%)   | all `error`/`cancelled` outcomes                          | Potentially high volume; success-latency estimate tolerates loss |
| `query_run`           | 100‰ (10%)   | first query per session; all `error`/`cancelled` outcomes | Highest-volume event; latency estimate via sampling is unbiased  |

### 5.1 Sampling algorithm

Deterministic hash-based sampling so a given event is consistently in or out and a
single install cannot be fully captured or fully excluded by chance:

```text
included(event) :=
  (rate_per_mille === 1000)
  OR (firstOfSession(event))
  OR (errorOrCancel(event))
  OR (hmac_sha256(install_token, session_token || event || local_seq) mod 1000 < rate_per_mille)
```

`local_seq` is a per-session monotonic counter, not sent. The hash is computed locally
and only its pass/fail bit leaves the process. Errors/cancellations bypass sampling but
remain subject to the session volume cap.

### 5.2 Volume caps (defense in depth)

- Max 32 events buffered in memory per session; oldest dropped first.
- Max 256 KiB buffered; further events dropped.
- Max 2 send retries with exponential backoff, within the session only.
- Max body size per batch (implementation detail; the collector also enforces it).

### 5.3 Configurability — client vs collector

- **Client-side (authoritative):** compiled-in per-event rates; optional build/deploy
  overrides via `ASSAY_TELEMETRY_SAMPLE_<EVENT>` (per-mille integer). Rates cannot be
  changed by the collector at runtime — there is no config-download channel.
- **Collector-side (secondary only):** the collector may independently downsample for
  storage cost and applies rate limiting. Collector-side sampling never _adds_ events and
  does not affect the privacy model. The collector must not apply sampling in a way that
  causes it to persist a field the client wouldn't have sent.

---

## 6. Opt-out mechanics

### 6.1 Canonical switch and precedence

- **Canonical kill switch:** `ASSAY_NO_TELEMETRY`.
  - **Any defined, non-empty value disables telemetry**, including `0` and `false`
    (fail-safe: setting the variable at all expresses intent to opt out). Only an unset
    or empty variable leaves telemetry enabled.
  - ADR 0037 spells the older variable `DATAWORKBENCH_NO_TELEMETRY`; the product rename
    (ADR 0039) supersedes that spelling with `ASSAY_NO_TELEMETRY`. The old spelling is
    accepted as an alias during a transition window and then retired (open question OQ7).
- **Precedence (highest first):**
  1. `ASSAY_NO_TELEMETRY` (hard off; cannot be overridden by any in-product toggle).
  2. Per-invocation CLI flag `--no-telemetry` (off for that invocation).
  3. In-product preference (web Settings; CLI local config).
  4. Default: on (ADR 0037).
- **Endpoint gate:** even when enabled, telemetry is a no-op unless a valid endpoint is
  configured (§8). This means the stock source build sends nothing anywhere.

### 6.2 Where the preference lives

| Surface | Trigger to disable                   | Persisted where                                                    |
| ------- | ------------------------------------ | ------------------------------------------------------------------ |
| CLI     | `ASSAY_NO_TELEMETRY` (any value)     | Process environment (per invocation)                               |
| CLI     | `--no-telemetry`                     | That invocation only                                               |
| CLI     | First-run disclosure prompt / config | Local user config (implementation detail; e.g. `~/.config/assay/`) |
| Web     | `ASSAY_NO_TELEMETRY` at build/deploy | Build-time hard-off (no runtime override)                          |
| Web     | Settings toggle or disclosure "off"  | `localStorage['assay.telemetry'] = 'off'` (local only)             |

### 6.3 First-run disclosure copy (exact drafts)

**Web** (modal/banner, shown once per install before the first send; revision `1`):

```text
Help improve Assay — anonymously

Assay is local-first: your data stays on your machine. With your permission,
Assay sends a small amount of anonymous usage metadata to a server run by the
Assay project.

What is sent: which features you use (for example, "validation ran"), coarse
counts and size ranges, how long operations took, and whether they succeeded —
plus the app version and your OS family.

What is never sent: your data, cell values, file names or paths, SQL text or
query results, contract contents, column names, or anything that identifies you.

Anonymous usage metadata is on by default. Turn it off any time in Settings, or
set ASSAY_NO_TELEMETRY=1 before launching Assay. Turning it off takes effect
immediately and nothing further is sent.

[ Keep anonymous usage on (default) ]   [ Turn it off ]
```

**CLI** (written to **stderr only**, once per install, so `--format json` stdout stays
byte-clean; revision `1`):

```text
Assay sends anonymous usage metadata by default: which commands you run, coarse
counts and durations, success/failure, and the app/engine version. It never
sends your data, file names, SQL, or cell values. Disable with
ASSAY_NO_TELEMETRY=1 (or `assay --no-telemetry`). This notice is shown once.
See docs/engineering/06-telemetry-design.md.
```

Disclosure rules for the future implementation:

- The disclosure is shown **before the first send physically happens**.
- Setting `ASSAY_NO_TELEMETRY` or choosing "Turn it off" suppresses the disclosure on
  later runs and sends nothing.
- `--version` and `--help` print only their existing byte-pinned stdout; any disclosure
  goes to stderr and only when telemetry would otherwise be active.
- Automated tests and CI set `ASSAY_NO_TELEMETRY=1` so byte-pinned output is unaffected.

### 6.4 Check before every send

A single gate function is consulted immediately before constructing each batch:

```text
shouldSend() :=
  ASSAY_NO_TELEMETRY is unset/empty
  AND in-product preference != 'off'
  AND endpoint is configured and valid (§8)
  AND schema_version is supported
```

It re-reads the environment/preference each call (no cached "enabled" bit for the whole
session).

### 6.5 Opt-out mid-session

When the preference flips to off (env change, CLI flag, or web toggle):

1. clear the in-memory buffer synchronously (drop, never flush);
2. block all future `shouldSend()` calls for the session;
3. emit nothing about the opt-out itself (no "opted out" event).

There is no persistent queue, so no previously-buffered event survives an opt-out.

### 6.6 Clock-skew handling

The collector uses its own receipt time for retention and aggregation. `client_day` is
accepted only when within ±1 day of the collector's receipt date; otherwise the collector
stores the clamped value and increments a non-telemetry skew counter. Client-provided
time is never used for retention decisions.

---

## 7. Red-line never-collected list (testable assertions)

The future implementation's tests quote these verbatim. Each assertion states an
observable property, not an intention.

- **R1.** No event contains dataset contents, cell values, SQL text, query results,
  contract contents, or file names/paths. _Test: schema validation rejects any payload
  containing a field outside §3; a corpus of open/validate/diff/export runs with
  canary strings in paths, SQL, columns, and cells produces no canary in any emitted
  payload._
- **R2.** No field is a free-form string. Every field type is enum, boolean, bounded
  integer, or a fixed-grammar token. _Test: generator enumerates all field types and
  fails on any type that admits arbitrary text; the §4 table is regenerated and must
  match._
- **R3.** Failure events carry only a `reason_code`/`outcome` enum — never a message,
  stack, path, or SQL. _Test: inject an error whose message embeds a canary SQL string
  and a canary path; assert the emitted field is a fixed enum and the canary is absent._
- **R4.** `--key` column names, inferred key candidates, and contract rule/column names
  are never sent. _Test: run diff/validate with canary column names and assert absence._
- **R5.** No raw user-agent, URL/referrer, hostname, username, email, or account ID is
  captured; `os_family` is only the coarse enum. _Test: hostile UA/platform strings map
  to an enum or `other`._
- **R6.** With no endpoint configured, the process performs **zero** network calls and
  allocates no telemetry queue/timer. _Test: network sandbox asserts zero egress; the
  telemetry module reports disabled._
- **R7.** With `ASSAY_NO_TELEMETRY` set (any value), zero events are constructed or sent,
  and no buffer exists. _Test: module-level counter is zero._
- **R8.** Opt-out mid-session clears the buffer and blocks subsequent sends. _Test: buffer
  an event, flip off, assert buffer cleared and no egress._
- **R9.** Telemetry never blocks or alters a user operation; send failures and timeouts
  are swallowed. _Test: a hanging/5xx collector does not delay CLI exit beyond the budget
  or the web UI thread._
- **R10.** No event or field may be added without a `schema_version` change and a matching
  §4 row. _Test: schema snapshot diff against this document fails on unlisted fields._
- **R11.** The collector persists only the allowlisted typed fields and drops unknown
  fields; it never logs or stores raw request bodies. _Test: send a payload with an extra
  free-form field; assert it is not stored or logged._
- **R12.** No third-party endpoints or SDKs; the only egress destination is the configured
  self-hosted collector. _Test: egress allowlist assertion._
- **R13.** No persistent on-disk telemetry queue exists. _Test: filesystem snapshot shows
  no telemetry artifacts._

---

## 8. Collector endpoint configuration

### 8.1 Configuration sources

| Surface | Variable / mechanism                                      | Notes                                                            |
| ------- | --------------------------------------------------------- | ---------------------------------------------------------------- |
| CLI     | `ASSAY_TELEMETRY_ENDPOINT`                                | URL of the self-hosted minimal collector                         |
| CLI     | `ASSAY_TELEMETRY_TOKEN` (optional)                        | Write-only ingest token sent as an `Authorization` header        |
| Web     | `ASSAY_TELEMETRY_ENDPOINT` injected at build time         | Vite `define`/`import.meta.env`; the stock build leaves it unset |
| Web     | `ASSAY_TELEMETRY_TOKEN` injected at build time (optional) | Same                                                             |

- **No endpoint is baked into the repository source.** The project's own collector
  endpoint (if any) is injected at build/release time, never committed as a default.
- **Unset/empty ⇒ silent no-op.** When no valid endpoint is configured, the telemetry
  module never constructs an event, starts a timer, opens a socket, or writes to disk.
  A stock source build therefore sends nothing anywhere. (This is red line R6.)
- **Invalid ⇒ disabled.** A non-URL, wrong scheme, or unparseable value is treated as
  unconfigured; a one-line **local** warning may be shown, but nothing is sent.

### 8.2 Endpoint validation

- `https://…` is always permitted.
- `http://…` is permitted **only** for loopback hosts (`localhost`, `127.0.0.1`,
  `[::1]`) to support local/self-hosted development collectors. Any other cleartext
  endpoint is rejected and disables telemetry.
- Credentials must never be embedded in the URL; the optional token is transport-only
  and is never logged, persisted in events, or treated as telemetry.

### 8.3 Transport shape (design sketch)

- One compact JSON body per batch over the validated endpoint; batch ≤ 32 events /
  ≤ 256 KiB; optional gzip.
- Non-blocking by design: bounded timeout; failures swallowed (R9). CLI uses a short
  exit flush budget and never delays beyond it.
- 2xx ⇒ batch accepted. 4xx ⇒ drop the batch without retry (a schema/client bug must not
  loop). 5xx/timeout ⇒ at most 2 bounded retries within the session, then drop.

---

## 9. Schema versioning

- The envelope carries integer `schema_version`. **Current version: `1`.**
- **Additive-only within a major version:**
  - adding a new event (with §4 rows);
  - appending new enum members (existing members keep their meaning);
  - adding optional fields;
  - adding new bucket labels **only if no existing label's meaning changes**.
- **Breaking (requires a major bump + dual-read window):** removing or renaming a field
  or event; narrowing an enum; changing a field's type; changing bucket boundaries or
  meanings; changing the envelope's meaning.
- The client only ever sends its known `schema_version`. The collector rejects unknown
  major versions (counter only, no body logging) and supports the current and previous
  major for at least one release cycle / 90 days during a migration.
- `event` names are part of the schema: renaming is remove + add across majors.
- **Unknown fields are dropped by the collector before storage** (never persisted, never
  logged), so a future buggy client cannot smuggle an unlisted field into the store. In
  strict mode the collector may reject the event instead; either way no raw body is kept.
- This document's §3/§4 tables and the schema version must change together (R10).

---

## 10. Retention sketch (minimal collector)

The collector is self-hosted and minimal (D2b). This is a sketch; exact windows are an
implementation choice with privacy floor below.

| Data                                              | Retention                       | Notes                                                               |
| ------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------- |
| Raw typed events (allowlisted fields only)        | 90 days, then deleted           | Partitioned by collector receipt date (`client_day` is not trusted) |
| Daily aggregates (counts/buckets only, no tokens) | 24 months                       | Derived after aggregation; no `install_token`/`session_token`       |
| Server operational logs                           | ≤ 14 days                       | No request bodies, no event payloads, no IP addresses               |
| IP addresses                                      | **never persisted**             | Used in memory for rate limiting only, dropped immediately          |
| Unknown/rejected payloads                         | **never stored or logged**      | Reject counter only                                                 |
| Backups                                           | same or shorter than raw window | No raw events beyond 90 days in backups                             |

Pseudonym note: `install_token` is retained only inside the 90-day raw window. Longer-term
repeat-usage trends are derived as aggregate distinct counts with no token retained.
Users can break linkage by resetting the local install token (implementation detail;
optional server-side delete-by-token is OQ5).

---

## 11. Open questions for the maintainer

Defaults are proposed so these do not block; the orchestrator/maintainer may override.

| #    | Question                                                                                                                                 | Proposed default                                                                  |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| OQ1  | Exact bucket boundaries (size/rows/columns/duration/findings)                                                                            | The values in §3; tune before implementation if desired                           |
| OQ2  | Keep `install_token` for repeat-usage measurement?                                                                                       | Yes — CSPRNG, resettable, 90-day raw retention, never derived from user/hardware  |
| OQ3  | Emit `disclosure_shown`?                                                                                                                 | Yes — compliance evidence, one per install                                        |
| OQ4  | Add `--no-telemetry` CLI flag in addition to the env var?                                                                                | Yes (ADR 0037 already anticipates a CLI flag)                                     |
| OQ5  | Server-side delete-by-install-token endpoint?                                                                                            | No in v1; local token reset only; revisit if requested                            |
| OQ6  | Web opt-out: build-time env only, runtime toggle only, or both?                                                                          | Both — build-time hard-off for stock builds, localStorage toggle in the app       |
| OQ7  | Retirement window for the `DATAWORKBENCH_NO_TELEMETRY` alias                                                                             | Accept as alias for one release, then retire                                      |
| OQ8  | Drop `session_token`?                                                                                                                    | No — needed for session caps/dedup; ephemeral, fixed grammar                      |
| OQ9  | Elevate the "typed schema is the privacy mechanism / no free-form strings" rule to an ADR?                                               | Candidate for a durable ADR; this design keeps it as red line R2 pending approval |
| OQ10 | **RESOLVED (2026-09-21, pt0-1):** `docs/product/04-post-mvp-track.md` §4 item 1 now reads opt-out (ADR 0037/D2a); row retained as record | closed                                                                            |

**ADR note.** No `docs/adr/0042-*.md` was drafted. Every hard commitment here
(opt-out, exclusions, self-hosted minimal collector, metadata-only allowlist) is already
decided in ADR 0025/0037 and D2a/D2b; the remaining choices are design details of an
artifact the maintainer approves directly. OQ9 is the only candidate durable commitment
and is flagged rather than silently decided.

---

## Appendix A. Leak drills run against this schema

These were executed against the schema in §3/§4; outcomes are recorded in the task
report. "Impossible" means no conforming payload can carry the item.

| #   | Drill (attempt to smuggle an ADR 0025 exclusion)                                    | Outcome                                                                                                                                         |
| --- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Embed raw SQL/driver error text in a failure event                                  | Impossible: `dataset_open_failed` has only `reason_code` enum; R3 test cannot see a message                                                     |
| D2  | Embed a filename/path in any field                                                  | Impossible: no path/name field; `dataset_opened` refuses filename; `unknown` format is an enum, not the extension                               |
| D3  | Smuggle a filename via a free-form "version" string                                 | Impossible: version is three bounded integers; pre-release strings are not represented                                                          |
| D4  | Smuggle data through `--key` column names (CLI diff)                                | Impossible: only `key_mode` enum; key names never read by telemetry                                                                             |
| D5  | Smuggle contract rule text / allowed values into `validation_run`                   | Impossible: `checks_run` is a count; `finding_count_bucket` is coarse; no rule text field                                                       |
| D6  | Encode a cell value in a duration or count                                          | Bounded to coarse buckets (durations) or clamped small integers (counts); representation cannot hold text; provenance is timing/counts only     |
| D7  | Encode directory structure via a "path kind" enum                                   | Impossible: no path-derived field; `size_bucket`/`format_kind` are content-kind, not location                                                   |
| D8  | Smuggle a raw user-agent (fingerprint) via `os_family`                              | Impossible: hostile UA/platform strings map to `linux/macos/windows/other`; raw string discarded                                                |
| D9  | Smuggle data through `install_token`/`session_token` by making them user-controlled | They are CSPRNG-generated, fixed 32/16-hex, never derived from any user/dataset value; resettable; threat model §4.1 excludes a tampered client |
| D10 | Add an unknown free-form field to a payload and have the collector store it         | Collector drops unlisted fields and never logs/stores raw bodies (§9, R11)                                                                      |
| D11 | Widen `reason_code` by concatenating an error message onto a code                   | Collector validates against the closed enum; any non-enum value is rejected (§9)                                                                |
| D12 | Send an entire raw CLI argv (contains paths/keys)                                   | Impossible by design: telemetry never reads `argv`; only the §3 enums/counts are constructed                                                    |

## Appendix B. Failure-path totality

| Condition                               | Expected behaviour                                                                                 |
| --------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Offline                                 | Batch stays in the bounded in-memory buffer; retried within session; dropped at exit; never blocks |
| Collector unreachable (DNS/TLS)         | Same as offline; error swallowed; no user-visible failure                                          |
| Collector 5xx / timeout                 | ≤ 2 bounded retries, then drop; no blocking                                                        |
| Collector 4xx                           | Drop batch, no retry (client/schema bug), never loop                                               |
| Endpoint unset/empty                    | Silent no-op: no event construction, no timer, no socket, no disk write (R6)                       |
| Endpoint invalid/cleartext non-loopback | Treated as unconfigured; local warning only; nothing sent                                          |
| `ASSAY_NO_TELEMETRY` at start           | No event constructed; disclosure suppressed; no buffer (R7)                                        |
| Opt-out mid-session                     | Buffer cleared synchronously; all later `shouldSend()` false; no opt-out event emitted (R8)        |
| Schema version unknown (collector)      | Client sends only its version; collector rejects unknown major with a counter, no body logging     |
| Clock skew                              | Collector clamps `client_day` to ±1 day and uses its own receipt time for retention (R6 §6.6)      |
| Oversized batch                         | Split at 32 events / 256 KiB; excess dropped, never unbounded                                      |
| Corrupt/partial event                   | Collector schema-validates; rejects without storing/logging the body                               |
| Process killed mid-send                 | Nothing persisted; no partial on-disk queue (R13)                                                  |

## Appendix C. Event-source totality

Every place a surface could emit an event, and what it emits (or deliberately doesn't).

| Surface | Point                                | Emits                                           | Gate / note                                           |
| ------- | ------------------------------------ | ----------------------------------------------- | ----------------------------------------------------- |
| web     | app boot                             | `app_boot`                                      | opt-out + endpoint gate first                         |
| web     | disclosure render                    | `disclosure_shown`                              | only on first run                                     |
| web     | open success                         | `dataset_opened`                                | role `primary`                                        |
| web     | open failure                         | `dataset_open_failed`                           | reason code only                                      |
| web     | validation finish                    | `validation_run`                                | pass/fail/error/abort                                 |
| web     | diff finish                          | `diff_run`                                      | aspect-ordered; no keys/values                        |
| web     | profile finish                       | `profile_run`                                   | 25% sample                                            |
| web     | SQL/filter/sort/nested/paging finish | `query_run`                                     | 10% sample; first + errors always                     |
| web     | export finish (`exportView`)         | `export_run`                                    | no path/name                                          |
| web     | settings toggle / disclosure off     | none                                            | opt-out emits nothing (R8)                            |
| cli     | `--help` / `--version`               | none                                            | byte-pinned stdout untouched; no telemetry            |
| cli     | usage error (exit 2)                 | none                                            | argv/paths never read by telemetry                    |
| cli     | validate success/failure             | `validation_run` (+ `dataset_opened`/`_failed`) | counts/codes only                                     |
| cli     | diff success/failure                 | `diff_run` (+ `dataset_opened`/`_failed` ×2)    | `key_mode` only; no key names                         |
| cli     | unknown/unhandled exception          | `dataset_open_failed`/`outcome=error` at most   | message never echoed (matches current CLI discipline) |
| any     | collector/report/render internals    | none                                            | no telemetry from logs, errors, or UI internals       |
