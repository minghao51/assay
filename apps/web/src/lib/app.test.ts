// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import {
  APP_NAME,
  IDLE_CAPABILITY,
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
