// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import {
  EMPTY_CSV_REVIEW_FORM,
  adoptionOptions,
  effectiveOptionEntries,
  formOptionRecord,
  optionsFingerprint,
  previewOptions,
  wireCsvOptions,
} from './options'
import type { CsvReviewForm } from './options'

/**
 * EW-03I-b — the option model against the engine's own vocabulary.
 *
 * These tests do not re-state the vocabulary: every refusal asserted here is
 * the string `@assay/engine-duckdb`'s `parseCsvOptions` produces, so a change
 * to the vocabulary (or a second, drifted copy of it in the web app) fails
 * here. The two locally authored behaviours are the types-textarea line syntax
 * (no value is ever echoed) and the two deliberate narrowings documented in
 * `options.ts`.
 */

function form(patch: Partial<CsvReviewForm> = {}): CsvReviewForm {
  return { ...EMPTY_CSV_REVIEW_FORM, ...patch }
}

describe('formOptionRecord — only the vocabulary keys, only when set', () => {
  it('omits every unset field instead of sending undefined values', () => {
    const built = formOptionRecord(EMPTY_CSV_REVIEW_FORM)
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.record).toEqual({})
  })

  it('maps a fully populated form onto exactly the closed vocabulary keys', () => {
    const built = formOptionRecord(
      form({
        delim: ';',
        header: 'yes',
        allVarchar: 'no',
        sampleSize: '1000',
        nullstr: 'NA',
        dateformat: '%Y-%m-%d',
        quote: '"',
        escape: '\\',
        comment: '#',
        skip: '2',
        typesText: 'id: BIGINT\nlabel: VARCHAR',
      }),
    )
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(Object.keys(built.record).sort()).toEqual([
      'all_varchar',
      'columns',
      'comment',
      'dateformat',
      'delim',
      'escape',
      'header',
      'nullstr',
      'quote',
      'sample_size',
      'skip',
    ])
    expect(built.record['columns']).toEqual({ id: 'BIGINT', label: 'VARCHAR' })
    expect(built.record['header']).toBe(true)
    expect(built.record['all_varchar']).toBe(false)
    expect(built.record['skip']).toBe(2)
    expect(built.record['sample_size']).toBe(1000)
  })

  it('refuses a malformed types line with its own value-free sentence', () => {
    const built = formOptionRecord(form({ typesText: 'id BIGINT' }))
    expect(built.ok).toBe(false)
    const refused = previewOptions(form({ typesText: 'id BIGINT' }))
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.reason).toBe('Each line must read name: TYPE.')
    // The refusal never echoes the typed line (a header name is dataset content).
    expect(refused.reason).not.toContain('id')
  })

  it('treats an empty types box as "no declaration", not an empty map', () => {
    const built = formOptionRecord(form({ typesText: '   \n  ' }))
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.record['columns']).toBeUndefined()
  })
})

describe('previewOptions — the engine vocabulary decides, not this module', () => {
  it('accepts a well-formed set and returns the canonical options', () => {
    const parsed = previewOptions(form({ delim: '|', header: 'no', sampleSize: '10' }))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.options).toEqual({ header: false, delim: '|', sample_size: 10 })
  })

  it('surfaces the vocabulary refusal for a non-numeric skip, naming the key', () => {
    const parsed = previewOptions(form({ skip: 'soon' }))
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.reason).toBe('CSV option skip must be a non-negative safe integer')
  })

  it('surfaces the inference-budget refusal for sample_size = -1', () => {
    const parsed = previewOptions(form({ sampleSize: '-1' }))
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.reason).toContain('CSV option sample_size = -1')
    expect(parsed.reason).toContain('100000 rows')
  })

  it('refuses a sample_size past the budget', () => {
    const parsed = previewOptions(form({ sampleSize: '100001' }))
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.reason).toContain('exceeds the preview inference budget')
  })

  it('refuses a declared type the engine validator rejects', () => {
    // `DECIMAL(1,2,3)` is well-shaped enough to reach a binder but is not a
    // type expression (the validator's arity rule). A merely UNKNOWN type name
    // is accepted here by design (the validator proves shape, not the catalog)
    // and then fails in the engine, whose first line the failure surface
    // shows — see the row report's option matrix.
    const parsed = previewOptions(form({ typesText: 'id: DECIMAL(1,2,3)' }))
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.reason).toBe('CSV option columns.id is not a valid engine type expression')
  })

  it('refuses a 65-code-point string option before dispatch', () => {
    const parsed = previewOptions(form({ delim: 'x'.repeat(65) }))
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.reason).toContain('at most 64 code points')
  })
})

describe('adoptionOptions — sample_size never rides engine/open (ADR 0049 item 1)', () => {
  it('drops sample_size and keeps every other reviewed option', () => {
    const parsed = previewOptions(
      form({
        delim: ';',
        header: 'yes',
        allVarchar: 'yes',
        sampleSize: '500',
        typesText: 'a: BIGINT',
      }),
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const adopted = adoptionOptions(parsed.options)
    expect(adopted).toEqual({
      header: true,
      delim: ';',
      all_varchar: true,
      columns: { a: 'BIGINT' },
    })
    expect('sample_size' in adopted).toBe(false)
  })

  it('copies the declared-columns map instead of aliasing it', () => {
    const parsed = previewOptions(form({ typesText: 'a: BIGINT' }))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const adopted = adoptionOptions(parsed.options)
    expect(adopted.columns).not.toBe(parsed.options.columns)
    expect(adopted.columns).toEqual({ a: 'BIGINT' })
  })
})

describe('declared types — a repeated column name is refused, never overwritten (B01)', () => {
  it('refuses a repeated name even when the type repeats exactly', () => {
    const built = formOptionRecord(form({ typesText: 'id: BIGINT\nid: BIGINT' }))
    expect(built.ok).toBe(false)
    if (built.ok) return
    expect(built.refusal).toEqual({ code: 'duplicate-column', line: 2 })
  })

  it('refuses a repeated name with a different type (no silent last-wins overwrite)', () => {
    // The pre-fix code assigned `columns[name] = type`, so the second line
    // silently replaced the first: a declared type was lost with no notice.
    const built = formOptionRecord(form({ typesText: 'id: BIGINT\nid: VARCHAR' }))
    expect(built.ok).toBe(false)
    if (built.ok) return
    expect(built.refusal).toEqual({ code: 'duplicate-column', line: 2 })
  })

  it('decides sameness from the parsed names (surrounding whitespace stripped)', () => {
    const built = formOptionRecord(form({ typesText: '  id : BIGINT \n\tid:\tVARCHAR' }))
    expect(built.ok).toBe(false)
    if (built.ok) return
    expect(built.refusal).toEqual({ code: 'duplicate-column', line: 2 })
  })

  it('keeps names case-sensitive: a and A are different columns', () => {
    const built = formOptionRecord(form({ typesText: 'a: BIGINT\nA: VARCHAR' }))
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(Object.keys(built.record['columns'] as Record<string, string>)).toEqual(['a', 'A'])
  })

  it('keeps line numbering across blank lines', () => {
    const built = formOptionRecord(form({ typesText: '\n\nid: BIGINT\n   \nid: VARCHAR' }))
    expect(built.ok).toBe(false)
    if (built.ok) return
    expect(built.refusal).toEqual({ code: 'duplicate-column', line: 5 })
  })

  it('reports the malformed line number with its own value-free sentence', () => {
    const built = formOptionRecord(form({ typesText: 'id: BIGINT\nnope' }))
    expect(built.ok).toBe(false)
    if (built.ok) return
    expect(built.refusal).toEqual({ code: 'malformed-line', line: 2 })
    const refused = previewOptions(form({ typesText: 'id: BIGINT\nnope' }))
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.reason).toBe('Each line must read name: TYPE.')
  })

  it('refuses a repeat with a sentence that never echoes the name or the type', () => {
    const refused = previewOptions(form({ typesText: 'customer_id: BIGINT\ncustomer_id: TEXT' }))
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.reason).toBe('Each column name may be declared only once.')
    expect(refused.reason).not.toContain('customer_id')
    expect(refused.reason).not.toContain('BIGINT')
    expect(refused.reason).not.toContain('TEXT')
  })

  it('refuses the one literal name a columns map cannot own, instead of losing it', () => {
    // `Object.entries` sees a `__proto__` own key, but a plain object's
    // assignment for that name hits the inherited setter — the engine's
    // validated map drops the column and the declaration would silently
    // vanish. Refusing here is the non-lossy outcome for a literal name.
    const built = formOptionRecord(form({ typesText: 'id: BIGINT\n__proto__: VARCHAR' }))
    expect(built.ok).toBe(false)
    if (built.ok) return
    expect(built.refusal).toEqual({ code: 'unsupported-column-name', line: 2 })
    const refused = previewOptions(form({ typesText: '__proto__: VARCHAR' }))
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.reason).toBe('That column name cannot be declared here.')
    expect(refused.reason).not.toContain('__proto__')
  })

  it('carries other Object.prototype names as literal own keys, end to end', () => {
    const typesText = 'constructor: VARCHAR\ntoString: BIGINT'
    const built = formOptionRecord(form({ typesText }))
    expect(built.ok).toBe(true)
    if (!built.ok) return
    const columns = built.record['columns'] as Record<string, string>
    // Own-key-safe construction: no prototype chain to shadow a literal name.
    expect(Object.getPrototypeOf(columns)).toBeNull()
    expect(Object.hasOwn(columns, 'constructor')).toBe(true)
    expect(Object.hasOwn(columns, 'toString')).toBe(true)
    const parsed = previewOptions(form({ typesText }))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const wire = wireCsvOptions(parsed.options)
    // The engine request boundary is a structured clone; the names stay
    // literal keys of the map and never become the record's own prototype.
    expect(structuredClone(wire)).toEqual({
      columns: { constructor: 'VARCHAR', toString: 'BIGINT' },
    })
    expect(Object.getPrototypeOf(wire?.['columns'] as object)).toBe(Object.prototype)
  })

  it('leaves an ordinary declaration’s wire record byte-identical', () => {
    const parsed = previewOptions(form({ typesText: 'id: BIGINT\nlabel: VARCHAR' }))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(JSON.stringify(wireCsvOptions(parsed.options))).toBe(
      '{"columns":{"id":"BIGINT","label":"VARCHAR"}}',
    )
  })
})

describe('wireCsvOptions — the no-options request stays byte-identical', () => {
  it('returns undefined for an empty set so no options field is sent at all', () => {
    expect(wireCsvOptions({})).toBeUndefined()
  })

  it('returns a fresh plain record for a set', () => {
    const options = { delim: ';' }
    const wire = wireCsvOptions(options)
    expect(wire).toEqual({ delim: ';' })
    expect(wire).not.toBe(options)
  })
})

describe('effectiveOptionEntries / optionsFingerprint', () => {
  it('renders the effective set in the vocabulary canonical order', () => {
    const entries = effectiveOptionEntries({
      sample_size: 100,
      delim: ';',
      header: false,
      columns: { id: 'BIGINT' },
    })
    expect(entries.map((entry) => entry.key)).toEqual(['header', 'delim', 'columns', 'sample_size'])
    expect(entries.map((entry) => entry.value)).toEqual(['no', ';', 'id: BIGINT', '100'])
  })

  it('is empty when the read composed no option', () => {
    expect(effectiveOptionEntries({})).toEqual([])
  })

  it('fingerprints equal sets identically and different sets differently', () => {
    expect(optionsFingerprint({ delim: ';' })).toBe(optionsFingerprint({ delim: ';' }))
    expect(optionsFingerprint({ delim: ';' })).not.toBe(optionsFingerprint({ delim: ',' }))
    // sample_size is not part of the adoption set, so it cannot make two equal
    // adoptions look different (the sample it produced is still comparable via
    // the effective-options disclosure).
    expect(optionsFingerprint({ delim: ';', sample_size: 10 })).toBe(
      optionsFingerprint({ delim: ';', sample_size: 99 }),
    )
  })
})
