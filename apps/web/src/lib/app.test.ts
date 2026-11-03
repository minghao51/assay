// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import {
  APP_NAME,
  IDLE_CAPABILITY,
  IDLE_ENGINE_LINE,
  IDLE_ENGINE_NOTE,
  IDLE_EXAMPLE_ACTION,
  IDLE_EXAMPLE_HELPER,
  IDLE_FORMATS,
  OPEN_CANCEL_LABEL,
  OPEN_PROGRESS_LABEL,
  TAGLINE,
  openStatusCopy,
} from './app'

// R-03 (ug-2): the first-run idle screen states what the product does and
// which formats it opens. These constants are the exact copy the component
// renders; the scaffold/roadmap constants that used to live here are gone so
// no milestone or docs-oriented claim can return through this module.
describe('app idle copy', () => {
  it('identifies the product', () => {
    expect(APP_NAME).toBe('Assay')
    expect(TAGLINE).toBe('The local-first data workbench')
  })

  it('pins the R-03 capability sentence and format line exactly', () => {
    expect(IDLE_CAPABILITY).toBe('Inspect, query, validate, compare, and repair local datasets.')
    expect(IDLE_FORMATS).toBe('Opens .parquet · .csv · .jsonl · .json')
  })

  it('pins the R-05 example action and helper exactly', () => {
    expect(IDLE_EXAMPLE_ACTION).toBe('Try with example data')
    expect(IDLE_EXAMPLE_HELPER).toBe('Explore nested fields with a small synthetic example.')
  })
})

// R-12 (uxv-4): the idle engine explanation is static copy. These pins fix the
// two strings byte-exactly and assert the copy stays value-free and free of
// live-status/benchmark wording — the engine is named, its live state is not
// (ADR 0025: no filenames, counts, cell values or metrics).
describe('app idle engine explanation', () => {
  it('pins the R-12 explanatory line and supporting sentence exactly', () => {
    expect(IDLE_ENGINE_LINE).toBe('Powered by DuckDB-WASM · local query execution')
    expect(IDLE_ENGINE_NOTE).toBe(
      'Dataset contents are processed locally. Edits are staged; export writes a copy.',
    )
  })

  it('keeps the engine copy free of live status, benchmark, memory and version claims', () => {
    // Deliberately word-level, not substring-of-a-sentence: these are the claim
    // kinds the spec forbids, so a reworded live badge or metric still trips it.
    const forbidden = [
      'connected',
      'connecting',
      'online',
      'offline',
      'ready',
      'status',
      'benchmark',
      'latency',
      'throughput',
      'performance',
      'memory',
      'RAM',
      'faster',
      'runs in',
      'version',
      'v1.',
      'v2.',
    ]
    for (const copy of [IDLE_ENGINE_LINE, IDLE_ENGINE_NOTE]) {
      const lower = copy.toLowerCase()
      for (const claim of forbidden) {
        expect(lower).not.toContain(claim.toLowerCase())
      }
    }
  })
})

// ug-21: the opening-only affordances are named for assistive tech and the
// copy is value-free (no percentage, bytes, filename or row count; ADR 0025).
describe('app opening affordance copy', () => {
  it('keeps the existing status copy and pins value-free accessible names', () => {
    expect(openStatusCopy('idle')).toBe('No file open')
    expect(openStatusCopy('opening')).toBe('Opening…')
    expect(openStatusCopy('ready')).toBeNull()
    expect(openStatusCopy('error')).toBeNull()
    expect(OPEN_PROGRESS_LABEL).toBe('Opening progress')
    expect(OPEN_CANCEL_LABEL).toBe('Cancel opening')
  })
})
