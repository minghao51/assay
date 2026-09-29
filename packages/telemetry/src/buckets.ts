// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pure bucket classifiers for the §3 count/size/duration enums.
 *
 * The design fixes the **set** of bucket labels but not the numeric
 * interpretation of "1mb"/"1k"/"1m". This module encodes one documented
 * convention (a reviewer-visible implementation choice, not a schema change):
 *
 * - sizes use binary units (1 MB = 1024×1024, 1 GB = 1024³), matching the
 *   repo's human byte formatting (`formatBytes`);
 * - counts use 1k = 1000 and 1m = 1 000 000;
 * - a count equal to a bucket label's boundary belongs to the bucket that
 *   **names** it (`1_1k` is `[1, 1000)`, `1k_100k` is `[1000, 100 000)`, …);
 * - explicit integer ranges (`1_10`, `11_50`, `51_200`) are inclusive;
 * - non-finite/negative inputs degrade to the zero/empty bucket;
 * - duration thresholds are strict `<` on the upper edge.
 *
 * Classification is intentionally pure: emission surfaces pass the already-
 * measured count/size/duration and never a value's contents.
 */

import type {
  ColumnCountBucket,
  DurationBucket,
  FindingCountBucket,
  RowCountBucket,
  SizeBucket,
} from './schema.js'

const MIB = 1024 * 1024
const GIB = 1024 * 1024 * 1024

/** Classify a byte size into the `dataset_opened.size_bucket` enum (design §3.4). */
export function bucketSize(bytes: number): SizeBucket {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'empty'
  if (bytes < MIB) return 'lt_1mb'
  if (bytes < 10 * MIB) return '1mb_10mb'
  if (bytes < 100 * MIB) return '10mb_100mb'
  if (bytes < GIB) return '100mb_1gb'
  if (bytes < 10 * GIB) return '1gb_10gb'
  return 'gt_10gb'
}

/** Classify a row count into the shared row-count bucket (design §3.4/§3.9/§3.10). */
export function bucketRowCount(count: number): RowCountBucket {
  if (!Number.isFinite(count) || count < 1) return 'zero'
  if (count < 1_000) return '1_1k'
  if (count < 100_000) return '1k_100k'
  if (count < 1_000_000) return '100k_1m'
  if (count < 10_000_000) return '1m_10m'
  return '10m_plus'
}

/** Classify a column count into the column-count bucket (design §3.4/§3.8). */
export function bucketColumnCount(count: number): ColumnCountBucket {
  if (!Number.isFinite(count) || count < 1) return 'zero'
  if (count <= 10) return '1_10'
  if (count <= 50) return '11_50'
  if (count <= 200) return '51_200'
  return '200_plus'
}

/** Classify a finding count into the finding-count bucket (design §3.6). */
export function bucketFindingCount(count: number): FindingCountBucket {
  if (!Number.isFinite(count) || count < 1) return 'zero'
  if (count <= 10) return '1_10'
  if (count <= 100) return '11_100'
  if (count <= 1_000) return '101_1k'
  return '1k_plus'
}

/** Classify a duration in milliseconds into the duration bucket (design §3.6–§3.9). */
export function bucketDuration(milliseconds: number): DurationBucket {
  if (!Number.isFinite(milliseconds) || milliseconds < 50) return 'lt_50ms'
  if (milliseconds < 200) return '50ms_200ms'
  if (milliseconds < 1_000) return '200ms_1s'
  if (milliseconds < 5_000) return '1s_5s'
  if (milliseconds < 30_000) return '5s_30s'
  return '30s_plus'
}
