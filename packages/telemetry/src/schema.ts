// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * @assay/telemetry schema core — the typed field schema of the approved
 * telemetry design (`docs/engineering/06-telemetry-design.md` §3, adopted by
 * ADR 0045).
 *
 * ## The load-bearing rule
 *
 * Every telemetry field is one of: a **closed enum**, a **boolean**, a
 * **bounded integer**, or a **fixed-grammar token** (exact-length lowercase
 * hex). **No field is a free-form string** (ADR 0045; design §3/R2). The types
 * below make the ADR 0025 exclusions unrepresentable: there is no field whose
 * TypeScript type admits arbitrary text. The {@link NoFreeString} proof
 * constants near the bottom of this file fail to compile if a plain `string`
 * is ever introduced into an event shape.
 *
 * ## The descriptor is the single source of truth
 *
 * {@link ENVELOPE_SCHEMA} and {@link EVENT_SCHEMAS} are one machine-readable
 * descriptor (`event → fields → kind/values/bounds/clamp`). They are mapped
 * types constrained to the payload interfaces, so adding/removing a typed
 * field without updating the descriptor (or vice versa) is a compile error.
 * They drive:
 *
 * - validation (`validate.ts` walks the descriptor, never hand-coded field
 *   lists), and
 * - the §4/R10 schema snapshot test (the pinned `(event, field)` set).
 *
 * `pipeline_run` is **reserved, not constructible for schema v1** (design
 * §3.11): it is listed with no fields, and `validateEvent` rejects it as an
 * unknown event. Do not add fields to it here — that is a schema-version
 * decision (design §9).
 *
 * No environment reads live here: compiled-in rates/tables only, injected
 * config, no I/O (design §6 routes opt-out/env to the emission surfaces).
 */

/** Current telemetry schema version (design §3.1, §9). */
export const SCHEMA_VERSION = 1

// ---------------------------------------------------------------------------
// Field kinds — the closed representation set (ADR 0045)
// ---------------------------------------------------------------------------

/** The only field kinds a telemetry field may have (ADR 0045). */
export type FieldKind = 'enum' | 'boolean' | 'bounded-int' | 'token'

/** A closed set of literal values; the value is always a member. */
export interface EnumFieldSpec {
  readonly kind: 'enum'
  readonly values: readonly string[]
}

/** A boolean. Cannot carry text. */
export interface BooleanFieldSpec {
  readonly kind: 'boolean'
}

/**
 * A bounded integer. `clamp: true` means out-of-range values are clamped into
 * `[min, max]` rather than rejected (design §3.1 `client_day`, §3.6
 * `checks_run`); otherwise they are rejected.
 */
export interface BoundedIntFieldSpec {
  readonly kind: 'bounded-int'
  readonly min: number
  readonly max: number
  readonly clamp?: boolean
}

/** A fixed-grammar token: exactly `length` lowercase hex characters. */
export interface TokenFieldSpec {
  readonly kind: 'token'
  readonly length: number
}

/** One field's schema (the closed representation set, ADR 0045). */
export type FieldSpec = EnumFieldSpec | BooleanFieldSpec | BoundedIntFieldSpec | TokenFieldSpec

// ---------------------------------------------------------------------------
// Closed enum tables (design §3)
// ---------------------------------------------------------------------------

/** `surface` (design §3.1). `vscode` is reserved until the PT-V surface ships. */
export const SURFACES = ['web', 'cli', 'vscode'] as const
export type Surface = (typeof SURFACES)[number]

/** `app_boot.engine_family` (design §3.2). */
export const ENGINE_FAMILIES = ['duckdb_wasm', 'duckdb_node', 'unknown'] as const
export type EngineFamily = (typeof ENGINE_FAMILIES)[number]

/** `app_boot.os_family` (design §3.2) — a coarse enum, never the raw string. */
export const OS_FAMILIES = ['linux', 'macos', 'windows', 'other'] as const
export type OsFamily = (typeof OS_FAMILIES)[number]

/** `app_boot.build_channel` (design §3.2). */
export const BUILD_CHANNELS = ['release', 'dev', 'ci', 'unknown'] as const
export type BuildChannel = (typeof BUILD_CHANNELS)[number]

/** `dataset_*.dataset_role` (design §3.4/§3.5). */
export const DATASET_ROLES = ['primary', 'side_a', 'side_b'] as const
export type DatasetRole = (typeof DATASET_ROLES)[number]

/** `dataset_*.format_kind` / `export_run.target_format` (design §3.4/§3.10). */
export const FORMAT_KINDS = ['parquet', 'csv', 'jsonl', 'json', 'arrow', 'unknown'] as const
export type FormatKind = (typeof FORMAT_KINDS)[number]

/** `dataset_opened.size_bucket` (design §3.4). */
export const SIZE_BUCKETS = [
  'empty',
  'lt_1mb',
  '1mb_10mb',
  '10mb_100mb',
  '100mb_1gb',
  '1gb_10gb',
  'gt_10gb',
] as const
export type SizeBucket = (typeof SIZE_BUCKETS)[number]

/** `dataset_opened` / `export_run` / `query_run` row-count bucket (design §3.4/§3.9/§3.10). */
export const ROW_COUNT_BUCKETS = [
  'zero',
  '1_1k',
  '1k_100k',
  '100k_1m',
  '1m_10m',
  '10m_plus',
] as const
export type RowCountBucket = (typeof ROW_COUNT_BUCKETS)[number]

/** `dataset_opened` / `profile_run` column-count bucket (design §3.4/§3.8). */
export const COLUMN_COUNT_BUCKETS = ['zero', '1_10', '11_50', '51_200', '200_plus'] as const
export type ColumnCountBucket = (typeof COLUMN_COUNT_BUCKETS)[number]

/** `validation_run.finding_count_bucket` (design §3.6). */
export const FINDING_COUNT_BUCKETS = ['zero', '1_10', '11_100', '101_1k', '1k_plus'] as const
export type FindingCountBucket = (typeof FINDING_COUNT_BUCKETS)[number]

/** `duration_bucket` (validation/diff/profile/query, design §3.6–§3.9). */
export const DURATION_BUCKETS = [
  'lt_50ms',
  '50ms_200ms',
  '200ms_1s',
  '1s_5s',
  '5s_30s',
  '30s_plus',
] as const
export type DurationBucket = (typeof DURATION_BUCKETS)[number]

/** `dataset_open_failed.reason_code` (design §3.5) — a closed failure class, never a message. */
export const OPEN_FAILURE_REASONS = [
  'not_found',
  'permission_denied',
  'unreadable',
  'unsupported_format',
  'corrupt',
  'too_large',
  'out_of_memory',
  'engine_error',
  'unknown',
] as const
export type OpenFailureReason = (typeof OPEN_FAILURE_REASONS)[number]

/** `validation_run.outcome` (design §3.6). */
export const VALIDATION_OUTCOMES = ['pass', 'fail', 'error', 'aborted'] as const
export type ValidationOutcome = (typeof VALIDATION_OUTCOMES)[number]

/** `diff_run.outcome` (design §3.7). */
export const DIFF_OUTCOMES = ['no_differences', 'differences', 'error', 'aborted'] as const
export type DiffOutcome = (typeof DIFF_OUTCOMES)[number]

/** `diff_run.key_mode` (design §3.7) — *how* keys were chosen, never which. */
export const KEY_MODES = ['explicit', 'inferred', 'none'] as const
export type KeyMode = (typeof KEY_MODES)[number]

/** `profile_run` / `query_run` outcome (design §3.8/§3.9). */
export const SUCCESS_OUTCOMES = ['success', 'error', 'cancelled'] as const
export type SuccessOutcome = (typeof SUCCESS_OUTCOMES)[number]

/** `query_run.query_kind` (design §3.9) — a UI entry-point class, never SQL text. */
export const QUERY_KINDS = [
  'user_sql',
  'filter',
  'sort',
  'nested_action',
  'paging',
  'unknown',
] as const
export type QueryKind = (typeof QUERY_KINDS)[number]

/** `export_run.outcome` (design §3.10). */
export const EXPORT_OUTCOMES = ['success', 'error', 'cancelled', 'refused'] as const
export type ExportOutcome = (typeof EXPORT_OUTCOMES)[number]

/** Outcomes that bypass sampling (design §5 "error/cancelled" exceptions). */
export const BYPASS_OUTCOMES = ['error', 'cancelled', 'aborted'] as const

/** Every outcome value any event may carry. */
export type TelemetryOutcome = ValidationOutcome | DiffOutcome | SuccessOutcome | ExportOutcome

// ---------------------------------------------------------------------------
// Fixed-grammar tokens (design §3.1) — the only string-shaped fields
// ---------------------------------------------------------------------------

/** Token grammar: exactly this many lowercase hex characters. */
export const INSTALL_TOKEN_HEX_LENGTH = 32
export const SESSION_TOKEN_HEX_LENGTH = 16

declare const InstallTokenBrand: unique symbol
declare const SessionTokenBrand: unique symbol

/**
 * A 128-bit CSPRNG pseudonym, fixed grammar `[0-9a-f]{32}`. Never derived from
 * hardware, account, dataset, filename, or content (design §3.1/§4).
 */
export type InstallToken = string & { readonly [InstallTokenBrand]: true }

/**
 * A 64-bit CSPRNG per-process token, fixed grammar `[0-9a-f]{16}`; ephemeral
 * and discarded at exit (design §3.1).
 */
export type SessionToken = string & { readonly [SessionTokenBrand]: true }

// ---------------------------------------------------------------------------
// Envelope (design §3.1)
// ---------------------------------------------------------------------------

/**
 * The common envelope on every event. Every field is a bounded integer or a
 * fixed-grammar token — never free text.
 */
export interface Envelope {
  readonly schema_version: typeof SCHEMA_VERSION
  readonly event: EventName
  readonly surface: Surface
  readonly install_token: InstallToken
  readonly session_token: SessionToken
  readonly client_day: number
  readonly app_version_major: number
  readonly app_version_minor: number
  readonly app_version_patch: number
}

// ---------------------------------------------------------------------------
// Payloads (design §3.2–§3.10)
// ---------------------------------------------------------------------------

/** `app_boot` — design §3.2. */
export interface AppBootPayload {
  readonly engine_family: EngineFamily
  readonly os_family: OsFamily
  readonly build_channel: BuildChannel
}

/** `disclosure_shown` — design §3.3. */
export interface DisclosureShownPayload {
  readonly disclosure_revision: number
}

/** `dataset_opened` — design §3.4. No filename/path field exists by construction. */
export interface DatasetOpenedPayload {
  readonly dataset_role: DatasetRole
  readonly format_kind: FormatKind
  readonly size_bucket: SizeBucket
  readonly row_count_bucket: RowCountBucket
  readonly column_count_bucket: ColumnCountBucket
}

/** `dataset_open_failed` — design §3.5. Only a closed reason enum, never a message. */
export interface DatasetOpenFailedPayload {
  readonly dataset_role: DatasetRole
  readonly format_kind: FormatKind
  readonly reason_code: OpenFailureReason
}

/** `validation_run` — design §3.6. `checks_run` is clamped above the bound. */
export interface ValidationRunPayload {
  readonly checks_run: number
  readonly finding_count_bucket: FindingCountBucket
  readonly duration_bucket: DurationBucket
  readonly outcome: ValidationOutcome
}

/** `diff_run` — design §3.7. `key_mode` records how, never which keys. */
export interface DiffRunPayload {
  readonly aspects_count: number
  readonly key_mode: KeyMode
  readonly duration_bucket: DurationBucket
  readonly outcome: DiffOutcome
}

/** `profile_run` — design §3.8. No column names/types or statistics exist here. */
export interface ProfileRunPayload {
  readonly column_count_bucket: ColumnCountBucket
  readonly duration_bucket: DurationBucket
  readonly outcome: SuccessOutcome
}

/** `query_run` — design §3.9. No SQL text or result cells exist here. */
export interface QueryRunPayload {
  readonly query_kind: QueryKind
  readonly row_count_bucket: RowCountBucket
  readonly duration_bucket: DurationBucket
  readonly outcome: SuccessOutcome
}

/** `export_run` — design §3.10. No destination path/name exists here. */
export interface ExportRunPayload {
  readonly target_format: FormatKind
  readonly row_count_bucket: RowCountBucket
  readonly outcome: ExportOutcome
}

/**
 * The nine active events (design §2). `pipeline_run` is deliberately absent:
 * it is reserved and rejected for schema v1 (design §3.11).
 */
export const EVENTS = [
  'app_boot',
  'disclosure_shown',
  'dataset_opened',
  'dataset_open_failed',
  'validation_run',
  'diff_run',
  'profile_run',
  'query_run',
  'export_run',
] as const

/** An active (constructible) event name. */
export type EventName = (typeof EVENTS)[number]

/** The reserved, not-yet-constructible event (design §3.11). */
export const RESERVED_EVENTS = ['pipeline_run'] as const
export type ReservedEventName = (typeof RESERVED_EVENTS)[number]

/** Payload type per active event. */
export interface TelemetryPayload {
  readonly app_boot: AppBootPayload
  readonly disclosure_shown: DisclosureShownPayload
  readonly dataset_opened: DatasetOpenedPayload
  readonly dataset_open_failed: DatasetOpenFailedPayload
  readonly validation_run: ValidationRunPayload
  readonly diff_run: DiffRunPayload
  readonly profile_run: ProfileRunPayload
  readonly query_run: QueryRunPayload
  readonly export_run: ExportRunPayload
}

/** A complete, validated telemetry event: envelope + the event-selected payload. */
export type TelemetryEvent = {
  [K in EventName]: Envelope & TelemetryPayload[K] & { readonly event: K }
}[EventName]

// ---------------------------------------------------------------------------
// Descriptor (single source of truth)
// ---------------------------------------------------------------------------

/** Descriptor fields for a payload: exactly the payload's keys, all required. */
export type PayloadFieldSchema<Payload> = {
  readonly [K in keyof Payload]-?: FieldSpec
}

/** One event's descriptor. */
export interface EventSchema<Payload> {
  readonly fields: PayloadFieldSchema<Payload>
}

/** Envelope descriptor (`event` is an enum over the active allowlist). */
export const ENVELOPE_SCHEMA: PayloadFieldSchema<Envelope> = {
  schema_version: { kind: 'bounded-int', min: SCHEMA_VERSION, max: SCHEMA_VERSION },
  event: { kind: 'enum', values: EVENTS },
  surface: { kind: 'enum', values: SURFACES },
  install_token: { kind: 'token', length: INSTALL_TOKEN_HEX_LENGTH },
  session_token: { kind: 'token', length: SESSION_TOKEN_HEX_LENGTH },
  client_day: { kind: 'bounded-int', min: 19000, max: 40000, clamp: true },
  app_version_major: { kind: 'bounded-int', min: 0, max: 999 },
  app_version_minor: { kind: 'bounded-int', min: 0, max: 999 },
  app_version_patch: { kind: 'bounded-int', min: 0, max: 9999 },
}

/**
 * The active event descriptors. The mapped type ties each entry to its payload
 * interface: a payload field with no descriptor (or a descriptor field with no
 * payload field) is a compile error, so the descriptor cannot silently drift
 * from the types.
 */
export const EVENT_SCHEMAS: { readonly [K in EventName]: EventSchema<TelemetryPayload[K]> } = {
  app_boot: {
    fields: {
      engine_family: { kind: 'enum', values: ENGINE_FAMILIES },
      os_family: { kind: 'enum', values: OS_FAMILIES },
      build_channel: { kind: 'enum', values: BUILD_CHANNELS },
    },
  },
  disclosure_shown: {
    fields: {
      disclosure_revision: { kind: 'bounded-int', min: 1, max: 999 },
    },
  },
  dataset_opened: {
    fields: {
      dataset_role: { kind: 'enum', values: DATASET_ROLES },
      format_kind: { kind: 'enum', values: FORMAT_KINDS },
      size_bucket: { kind: 'enum', values: SIZE_BUCKETS },
      row_count_bucket: { kind: 'enum', values: ROW_COUNT_BUCKETS },
      column_count_bucket: { kind: 'enum', values: COLUMN_COUNT_BUCKETS },
    },
  },
  dataset_open_failed: {
    fields: {
      dataset_role: { kind: 'enum', values: DATASET_ROLES },
      format_kind: { kind: 'enum', values: FORMAT_KINDS },
      reason_code: { kind: 'enum', values: OPEN_FAILURE_REASONS },
    },
  },
  validation_run: {
    fields: {
      checks_run: { kind: 'bounded-int', min: 0, max: 10000, clamp: true },
      finding_count_bucket: { kind: 'enum', values: FINDING_COUNT_BUCKETS },
      duration_bucket: { kind: 'enum', values: DURATION_BUCKETS },
      outcome: { kind: 'enum', values: VALIDATION_OUTCOMES },
    },
  },
  diff_run: {
    fields: {
      aspects_count: { kind: 'bounded-int', min: 0, max: 4 },
      key_mode: { kind: 'enum', values: KEY_MODES },
      duration_bucket: { kind: 'enum', values: DURATION_BUCKETS },
      outcome: { kind: 'enum', values: DIFF_OUTCOMES },
    },
  },
  profile_run: {
    fields: {
      column_count_bucket: { kind: 'enum', values: COLUMN_COUNT_BUCKETS },
      duration_bucket: { kind: 'enum', values: DURATION_BUCKETS },
      outcome: { kind: 'enum', values: SUCCESS_OUTCOMES },
    },
  },
  query_run: {
    fields: {
      query_kind: { kind: 'enum', values: QUERY_KINDS },
      row_count_bucket: { kind: 'enum', values: ROW_COUNT_BUCKETS },
      duration_bucket: { kind: 'enum', values: DURATION_BUCKETS },
      outcome: { kind: 'enum', values: SUCCESS_OUTCOMES },
    },
  },
  export_run: {
    fields: {
      target_format: { kind: 'enum', values: FORMAT_KINDS },
      row_count_bucket: { kind: 'enum', values: ROW_COUNT_BUCKETS },
      outcome: { kind: 'enum', values: EXPORT_OUTCOMES },
    },
  },
}

/** The descriptor for a specific active event. */
export function eventSchemaFor(event: EventName): EventSchema<TelemetryPayload[typeof event]> {
  return EVENT_SCHEMAS[event]
}

/**
 * `pipeline_run` is reserved: listed for allowlist completeness, but has no
 * fields and no emitter, and `validateEvent` rejects it as unknown for schema
 * v1 (design §3.11). This constant exists only to document the reservation.
 */
export const RESERVED_PIPELINE_RUN = {
  event: 'pipeline_run',
  reserved: true,
  fields: {},
} as const satisfies {
  readonly event: ReservedEventName
  readonly reserved: true
  readonly fields: Readonly<Record<string, never>>
}

// ---------------------------------------------------------------------------
// D8: os_family is a coarse enum, parsed from a discarded platform string
// ---------------------------------------------------------------------------

/**
 * Map a platform/user-agent string to the closed `os_family` enum (design
 * §3.2, Appendix A D8). The raw string is discarded: anything unrecognized —
 * including a hostile or fingerprint-bearing user-agent — becomes `other`.
 * Total and dependency-free; takes the already-read string as an argument
 * (this module never reads a global platform source).
 */
export function classifyOsFamily(platform: unknown): OsFamily {
  if (typeof platform !== 'string') return 'other'
  const value = platform.toLowerCase()
  // Check macos before windows: "darwin" contains the substring "win".
  if (value.includes('mac') || value.includes('darwin')) return 'macos'
  if (value.includes('linux') || value.includes('x11')) return 'linux'
  if (value.includes('win')) return 'windows'
  return 'other'
}

// ---------------------------------------------------------------------------
// Mechanical "no free-form string" proof (ADR 0045, design R2)
// ---------------------------------------------------------------------------

/**
 * Resolves to `unknown` for a field-type union that cannot be a bare `string`,
 * and to `never` if it admits arbitrary text. Each proof constant below is
 * typed with this: introducing a plain `string` field anywhere makes the
 * corresponding constant's type `never`, and `true` is not assignable to
 * `never` — a compile error, mechanically enforcing ADR 0045.
 */
export type NoFreeString<T> = string extends T ? never : unknown

/** Envelope fields admit no free-form string. */
export const ENVELOPE_NO_FREE_STRING: NoFreeString<Envelope[keyof Envelope]> = true
/** `app_boot` payload fields admit no free-form string. */
export const APP_BOOT_NO_FREE_STRING: NoFreeString<AppBootPayload[keyof AppBootPayload]> = true
/** `disclosure_shown` payload fields admit no free-form string. */
export const DISCLOSURE_SHOWN_NO_FREE_STRING: NoFreeString<
  DisclosureShownPayload[keyof DisclosureShownPayload]
> = true
/** `dataset_opened` payload fields admit no free-form string. */
export const DATASET_OPENED_NO_FREE_STRING: NoFreeString<
  DatasetOpenedPayload[keyof DatasetOpenedPayload]
> = true
/** `dataset_open_failed` payload fields admit no free-form string. */
export const DATASET_OPEN_FAILED_NO_FREE_STRING: NoFreeString<
  DatasetOpenFailedPayload[keyof DatasetOpenFailedPayload]
> = true
/** `validation_run` payload fields admit no free-form string. */
export const VALIDATION_RUN_NO_FREE_STRING: NoFreeString<
  ValidationRunPayload[keyof ValidationRunPayload]
> = true
/** `diff_run` payload fields admit no free-form string. */
export const DIFF_RUN_NO_FREE_STRING: NoFreeString<DiffRunPayload[keyof DiffRunPayload]> = true
/** `profile_run` payload fields admit no free-form string. */
export const PROFILE_RUN_NO_FREE_STRING: NoFreeString<ProfileRunPayload[keyof ProfileRunPayload]> =
  true
/** `query_run` payload fields admit no free-form string. */
export const QUERY_RUN_NO_FREE_STRING: NoFreeString<QueryRunPayload[keyof QueryRunPayload]> = true
/** `export_run` payload fields admit no free-form string. */
export const EXPORT_RUN_NO_FREE_STRING: NoFreeString<ExportRunPayload[keyof ExportRunPayload]> =
  true
