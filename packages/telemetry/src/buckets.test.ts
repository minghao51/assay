// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import {
  bucketColumnCount,
  bucketDuration,
  bucketFindingCount,
  bucketRowCount,
  bucketSize,
} from './index.js'

const MIB = 1024 * 1024
const GIB = 1024 * 1024 * 1024

describe('bucket classifiers (design §3.4/§3.6–§3.10)', () => {
  it('classifies byte sizes by the documented binary convention', () => {
    expect(bucketSize(0)).toBe('empty')
    expect(bucketSize(-1)).toBe('empty')
    expect(bucketSize(Number.NaN)).toBe('empty')
    expect(bucketSize(1)).toBe('lt_1mb')
    expect(bucketSize(MIB - 1)).toBe('lt_1mb')
    expect(bucketSize(MIB)).toBe('1mb_10mb')
    expect(bucketSize(10 * MIB - 1)).toBe('1mb_10mb')
    expect(bucketSize(10 * MIB)).toBe('10mb_100mb')
    expect(bucketSize(100 * MIB)).toBe('100mb_1gb')
    expect(bucketSize(GIB)).toBe('1gb_10gb')
    expect(bucketSize(10 * GIB)).toBe('gt_10gb')
  })

  it('classifies row counts, a boundary value belonging to the bucket it names', () => {
    expect(bucketRowCount(0)).toBe('zero')
    expect(bucketRowCount(-3)).toBe('zero')
    expect(bucketRowCount(Number.NaN)).toBe('zero')
    expect(bucketRowCount(1)).toBe('1_1k')
    expect(bucketRowCount(999)).toBe('1_1k')
    expect(bucketRowCount(1_000)).toBe('1k_100k')
    expect(bucketRowCount(99_999)).toBe('1k_100k')
    expect(bucketRowCount(100_000)).toBe('100k_1m')
    expect(bucketRowCount(999_999)).toBe('100k_1m')
    expect(bucketRowCount(1_000_000)).toBe('1m_10m')
    expect(bucketRowCount(9_999_999)).toBe('1m_10m')
    expect(bucketRowCount(10_000_000)).toBe('10m_plus')
  })

  it('classifies column counts', () => {
    expect(bucketColumnCount(0)).toBe('zero')
    expect(bucketColumnCount(1)).toBe('1_10')
    expect(bucketColumnCount(10)).toBe('1_10')
    expect(bucketColumnCount(11)).toBe('11_50')
    expect(bucketColumnCount(50)).toBe('11_50')
    expect(bucketColumnCount(51)).toBe('51_200')
    expect(bucketColumnCount(200)).toBe('51_200')
    expect(bucketColumnCount(201)).toBe('200_plus')
  })

  it('classifies finding counts', () => {
    expect(bucketFindingCount(0)).toBe('zero')
    expect(bucketFindingCount(1)).toBe('1_10')
    expect(bucketFindingCount(10)).toBe('1_10')
    expect(bucketFindingCount(11)).toBe('11_100')
    expect(bucketFindingCount(100)).toBe('11_100')
    expect(bucketFindingCount(101)).toBe('101_1k')
    expect(bucketFindingCount(1_000)).toBe('101_1k')
    expect(bucketFindingCount(1_001)).toBe('1k_plus')
  })

  it('classifies durations', () => {
    expect(bucketDuration(0)).toBe('lt_50ms')
    expect(bucketDuration(49)).toBe('lt_50ms')
    expect(bucketDuration(50)).toBe('50ms_200ms')
    expect(bucketDuration(199)).toBe('50ms_200ms')
    expect(bucketDuration(200)).toBe('200ms_1s')
    expect(bucketDuration(999)).toBe('200ms_1s')
    expect(bucketDuration(1_000)).toBe('1s_5s')
    expect(bucketDuration(4_999)).toBe('1s_5s')
    expect(bucketDuration(5_000)).toBe('5s_30s')
    expect(bucketDuration(29_999)).toBe('5s_30s')
    expect(bucketDuration(30_000)).toBe('30s_plus')
    expect(bucketDuration(Number.NaN)).toBe('lt_50ms')
  })
})
