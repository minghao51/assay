// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * @assay/telemetry — the pure, dependency-free telemetry client core
 * (design `docs/engineering/06-telemetry-design.md`, ADR 0045).
 *
 * Public surface: the typed schema + descriptor, the total validator, CSPRNG
 * token helpers, bucket classifiers, client-side sampling, endpoint validation,
 * and the pure `createTelemetryCore` gate. No transport, buffer, timer,
 * environment read, or network call lives here — the emission surfaces own
 * those (design §6/§8.3).
 */

export {
  SCHEMA_VERSION,
  EVENTS,
  RESERVED_EVENTS,
  SURFACES,
  ENGINE_FAMILIES,
  OS_FAMILIES,
  BUILD_CHANNELS,
  DATASET_ROLES,
  FORMAT_KINDS,
  SIZE_BUCKETS,
  ROW_COUNT_BUCKETS,
  COLUMN_COUNT_BUCKETS,
  FINDING_COUNT_BUCKETS,
  DURATION_BUCKETS,
  OPEN_FAILURE_REASONS,
  VALIDATION_OUTCOMES,
  DIFF_OUTCOMES,
  KEY_MODES,
  SUCCESS_OUTCOMES,
  QUERY_KINDS,
  EXPORT_OUTCOMES,
  BYPASS_OUTCOMES,
  INSTALL_TOKEN_HEX_LENGTH,
  SESSION_TOKEN_HEX_LENGTH,
  ENVELOPE_SCHEMA,
  EVENT_SCHEMAS,
  RESERVED_PIPELINE_RUN,
  eventSchemaFor,
  classifyOsFamily,
} from './schema.js'
export type {
  FieldKind,
  FieldSpec,
  EnumFieldSpec,
  BooleanFieldSpec,
  BoundedIntFieldSpec,
  TokenFieldSpec,
  Surface,
  EngineFamily,
  OsFamily,
  BuildChannel,
  DatasetRole,
  FormatKind,
  SizeBucket,
  RowCountBucket,
  ColumnCountBucket,
  FindingCountBucket,
  DurationBucket,
  OpenFailureReason,
  ValidationOutcome,
  DiffOutcome,
  KeyMode,
  SuccessOutcome,
  QueryKind,
  ExportOutcome,
  TelemetryOutcome,
  InstallToken,
  SessionToken,
  Envelope,
  AppBootPayload,
  DisclosureShownPayload,
  DatasetOpenedPayload,
  DatasetOpenFailedPayload,
  ValidationRunPayload,
  DiffRunPayload,
  ProfileRunPayload,
  QueryRunPayload,
  ExportRunPayload,
  EventName,
  ReservedEventName,
  TelemetryPayload,
  TelemetryEvent,
  EventSchema,
  PayloadFieldSchema,
} from './schema.js'

export { VALIDATION_ERRORS, validateEvent } from './validate.js'
export type { ValidationErrorCode, ValidationResult } from './validate.js'

export {
  isHexOfLength,
  isInstallToken,
  isSessionToken,
  generateInstallToken,
  generateSessionToken,
} from './tokens.js'

export {
  DEFAULT_RATES_PER_MILLE,
  MAX_RATE_PER_MILLE,
  platformHmacSha256,
  bucketOfDigest,
  resolveRates,
  createSampler,
} from './sampling.js'
export type { HmacSha256, SamplingContext, Sampler, SamplerConfig } from './sampling.js'

export { ENDPOINT_REJECTIONS, validateEndpoint, isTelemetryEnabled } from './endpoint.js'
export type { EndpointRejection, EndpointValidation } from './endpoint.js'

export { createTelemetryCore } from './core.js'
export type { EmitContext, TelemetryCore, TelemetryCoreConfig } from './core.js'

export {
  bucketSize,
  bucketRowCount,
  bucketColumnCount,
  bucketFindingCount,
  bucketDuration,
} from './buckets.js'
