// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  csvCreateViewSql,
  csvSampleSql,
  csvScanRelationSql,
  csvSniffSql,
  effectiveCsvOptions,
  MAX_CSV_INFERENCE_SAMPLE_ROWS,
  MAX_CSV_OPTION_VALUE_CODE_POINTS,
  MAX_CSV_TYPE_COLUMNS,
  parseCsvOptions,
} from './csv-options'
import { fileScanSql } from './format-view'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = join(PKG_ROOT, '..', '..')
const CSV_FIXTURES = join(REPO_ROOT, 'fixtures', 'csv')

// ---- parseCsvOptions: the closed vocabulary (ADR 0049 item 2) ----

describe('parseCsvOptions — accepted vocabulary', () => {
  it('parses every accepted scalar option and echoes it canonically', () => {
    const parsed = parseCsvOptions(
      {
        header: false,
        delim: ';',
        quote: "'",
        escape: '"',
        all_varchar: true,
        nullstr: 'NA',
        dateformat: '%Y-%m-%d',
        comment: '#',
        skip: 2,
      },
      'preview',
    )
    expect(parsed).toEqual({
      ok: true,
      options: {
        header: false,
        delim: ';',
        quote: "'",
        escape: '"',
        all_varchar: true,
        nullstr: 'NA',
        dateformat: '%Y-%m-%d',
        comment: '#',
        skip: 2,
      },
    })
  })

  it('resolves the sep alias to delim (EW-03D §2.1)', () => {
    const parsed = parseCsvOptions({ sep: ';' }, 'preview')
    expect(parsed).toEqual({ ok: true, options: { delim: ';' } })
  })

  it('resolves the types alias to columns and validates each type value', () => {
    const parsed = parseCsvOptions({ types: { v: 'VARCHAR', n: 'DECIMAL(18,2)' } }, 'open')
    expect(parsed).toEqual({ ok: true, options: { columns: { v: 'VARCHAR', n: 'DECIMAL(18,2)' } } })
  })

  it('accepts sample_size only in the preview context, inside the inference budget (ADR 0049 resolution 8)', () => {
    expect(parseCsvOptions({ sample_size: 100 }, 'preview')).toEqual({
      ok: true,
      options: { sample_size: 100 },
    })
    expect(parseCsvOptions({ sample_size: 0 }, 'preview')).toEqual({
      ok: true,
      options: { sample_size: 0 },
    })
    // The budget boundary: the limit is accepted exactly, beyond it refused.
    expect(parseCsvOptions({ sample_size: MAX_CSV_INFERENCE_SAMPLE_ROWS }, 'preview')).toEqual({
      ok: true,
      options: { sample_size: MAX_CSV_INFERENCE_SAMPLE_ROWS },
    })
    expect(parseCsvOptions({ sample_size: MAX_CSV_INFERENCE_SAMPLE_ROWS + 1 }, 'preview')).toEqual({
      ok: false,
      reason: `CSV option sample_size exceeds the preview inference budget (limit ${MAX_CSV_INFERENCE_SAMPLE_ROWS} rows)`,
    })
    // -1 (read every row) is REFUSED, never silently capped: an explicit user
    // value is not reinterpreted.
    expect(parseCsvOptions({ sample_size: -1 }, 'preview')).toEqual({
      ok: false,
      reason: `CSV option sample_size = -1 reads every row for inference and is refused: the preview inference budget is ${MAX_CSV_INFERENCE_SAMPLE_ROWS} rows`,
    })
    // The preview-only option never rides engine/open.
    expect(parseCsvOptions({ sample_size: 100 }, 'open')).toEqual({
      ok: false,
      reason: 'sample_size is a preview-only option and cannot ride engine/open',
    })
  })

  it('copies the columns map (the boundary is untrusted — no reference retention)', () => {
    const wire = { v: 'VARCHAR' }
    const parsed = parseCsvOptions({ columns: wire }, 'preview')
    if (!parsed.ok) throw new Error('parse failed')
    expect(parsed.options.columns).toEqual({ v: 'VARCHAR' })
    expect(parsed.options.columns).not.toBe(wire)
  })
})

describe('parseCsvOptions — refusals before dispatch (EW-03D §2.3, ADR 0049 item 3)', () => {
  it('refuses unknown keys with the key named, never the value', () => {
    expect(parseCsvOptions({ totally_made_up: 'x' }, 'preview')).toEqual({
      ok: false,
      reason: 'unsupported CSV option: totally_made_up',
    })
  })

  it('refuses the whole deferred list (ADR 0049 item 2)', () => {
    const deferred = [
      'strict_mode',
      'null_padding',
      'parallel',
      'encoding',
      'compression',
      'max_line_size',
      'buffer_size',
      'decimal_separator',
      'thousands',
    ]
    for (const key of deferred) {
      const parsed = parseCsvOptions({ [key]: true }, 'preview')
      expect(parsed.ok).toBe(false)
      if (parsed.ok) continue
      expect(parsed.reason).toContain(key)
    }
  })

  it('refuses the refused-always list — no silent row-skip, no rejects tables, no sniff control', () => {
    const refused = [
      'ignore_errors',
      'store_rejects',
      'rejects_scan',
      'rejects_table',
      'rejects_limit',
      'delimiter', // the installed build has no such parameter (B4/L7)
      'separator',
      'filename',
      'union_by_name',
      'hive_partitioning',
      'hive_types',
      'hive_types_autocast',
      'files_to_sniff',
      'column_names',
      'names',
      'normalize_names',
      'force_match',
      'auto_detect',
      'auto_type_candidates',
    ]
    for (const key of refused) {
      const parsed = parseCsvOptions({ [key]: true }, 'preview')
      expect(parsed.ok, key).toBe(false)
      if (parsed.ok) continue
      expect(parsed.reason.startsWith('refused CSV option:'), key).toBe(true)
    }
  })

  it('refuses both alias spellings at once as ambiguous', () => {
    expect(parseCsvOptions({ delim: ',', sep: ';' }, 'preview')).toMatchObject({ ok: false })
    expect(
      parseCsvOptions({ columns: { v: 'VARCHAR' }, types: { v: 'BIGINT' } }, 'preview'),
    ).toMatchObject({
      ok: false,
    })
  })

  it('refuses non-object option payloads and non-object column maps', () => {
    expect(parseCsvOptions(null, 'preview').ok).toBe(false)
    expect(parseCsvOptions([['v', 'VARCHAR']], 'preview').ok).toBe(false)
    expect(parseCsvOptions('header=true', 'preview').ok).toBe(false)
    expect(parseCsvOptions({ columns: 'VARCHAR' }, 'preview').ok).toBe(false)
  })

  it('refuses bad scalar values with the key named (values never echoed)', () => {
    expect(parseCsvOptions({ header: 'yes' }, 'preview')).toEqual({
      ok: false,
      reason: 'CSV option header must be a boolean',
    })
    expect(parseCsvOptions({ skip: -1 }, 'preview')).toMatchObject({ ok: false })
    expect(parseCsvOptions({ skip: 1.5 }, 'preview')).toMatchObject({ ok: false })
    expect(parseCsvOptions({ sample_size: -2 }, 'preview')).toMatchObject({ ok: false })
    expect(parseCsvOptions({ sample_size: Number.MAX_SAFE_INTEGER + 1 }, 'preview')).toMatchObject({
      ok: false,
    })
    const tooLong = 'd'.repeat(MAX_CSV_OPTION_VALUE_CODE_POINTS + 1)
    expect(parseCsvOptions({ delim: tooLong }, 'preview').ok).toBe(false)
  })

  it('bounds the declared-columns map and validates every type expression', () => {
    expect(parseCsvOptions({ columns: {} }, 'preview')).toMatchObject({ ok: false })
    const tooMany: Record<string, string> = {}
    for (let i = 0; i <= MAX_CSV_TYPE_COLUMNS; i += 1) tooMany[`c${i}`] = 'VARCHAR'
    expect(parseCsvOptions({ columns: tooMany }, 'preview').ok).toBe(false)
    // The injection-shaped type value of the m4-2 review must not pass here either.
    expect(
      parseCsvOptions(
        {
          columns: {
            v: 'VARCHAR) AS "c" FROM (...) ); CREATE TABLE assay_injected AS SELECT 31337; --',
          },
        },
        'preview',
      ),
    ).toMatchObject({ ok: false })
    expect(parseCsvOptions({ columns: { v: 'DECIMAL(1,2,3)' } }, 'preview')).toMatchObject({
      ok: false,
    })
  })
})

// ---- composition: SQL only from engine names + quoted literals + the closed vocabulary ----

describe('csvScanRelationSql — composition (EW-03D §2.2 rules 1–5)', () => {
  it('composes the bare scan byte-identically to the actual quick-open composer (no drift possible)', () => {
    // Against the REAL quick-open composer, not a duplicated literal: if
    // format-view.ts's CSV scan ever changes, this pin fails.
    expect(csvScanRelationSql('t1', {})).toBe(fileScanSql('t1', 'csv'))
  })

  it('composes scalar options in canonical order with literals quoted', () => {
    expect(csvScanRelationSql('t1', { header: true, delim: ';', skip: 3 })).toBe(
      "read_csv('t1', header = true, delim = ';', skip = 3)",
    )
    expect(csvScanRelationSql('t1', { nullstr: 'NA', all_varchar: true, sample_size: 100 })).toBe(
      "read_csv('t1', all_varchar = true, nullstr = 'NA', sample_size = 100)",
    )
  })

  it('keeps hostile string values inside their literals (quoting rule 2)', () => {
    const hostile = "'; DROP VIEW assay_t1; --"
    const sql = csvScanRelationSql('t1', { delim: hostile })
    // The leading quote is doubled, so the payload stays INSIDE the single
    // composed literal — one read_csv call, no statement separator outside it.
    expect(sql).toBe("read_csv('t1', delim = '''; DROP VIEW assay_t1; --')")
    expect(sql.startsWith("read_csv('t1', delim = '")).toBe(true)
    expect(sql.endsWith("')")).toBe(true)
    expect((sql.match(/read_csv/g) ?? []).length).toBe(1)
  })

  it('composes the columns map literal with string-quoted keys AND values (rule 5)', () => {
    expect(csvScanRelationSql('t1', { columns: { v: 'VARCHAR', n: 'BIGINT' } })).toBe(
      "read_csv('t1', columns = {'v': 'VARCHAR', 'n': 'BIGINT'})",
    )
    expect(csvScanRelationSql('t1', { columns: { "it's": 'VARCHAR' } })).toBe(
      "read_csv('t1', columns = {'it''s': 'VARCHAR'})",
    )
  })

  it('composes the preview sample with its cap stated in the SQL', () => {
    expect(csvSampleSql('preview_p1', { all_varchar: true }, 100)).toBe(
      "SELECT * FROM read_csv('preview_p1', all_varchar = true) LIMIT 100",
    )
    expect(() => csvSampleSql('preview_p1', {}, 0)).toThrow()
    expect(() => csvSampleSql('preview_p1', {}, 1.5)).toThrow()
  })
})

describe('csvSniffSql — the sniff receives inference options, not declarations', () => {
  it('passes every option except columns; sample_size rides (inference input)', () => {
    expect(csvSniffSql('preview_p1', { delim: ';', header: true, columns: { v: 'BIGINT' } })).toBe(
      "SELECT * FROM sniff_csv('preview_p1', header = true, delim = ';')",
    )
    expect(csvSniffSql('preview_p1', { sample_size: 10 })).toBe(
      "SELECT * FROM sniff_csv('preview_p1', sample_size = 10)",
    )
    expect(csvSniffSql('preview_p1', {})).toBe("SELECT * FROM sniff_csv('preview_p1')")
  })

  it('the sniffer Prompt is never composed into SQL by this module', () => {
    // The module has no API that takes or returns executable SQL from sniff
    // output: sniffSql's arguments are the option set only. Pinned behaviourally:
    // whatever the sniffer might report, the composed sniff stays name-only.
    expect(csvSniffSql('p1', {})).toBe("SELECT * FROM sniff_csv('p1')")
  })
})

describe('csvCreateViewSql — the options-aware adoption view', () => {
  it('binds the composed scan to the quoted engine-generated view name', () => {
    expect(csvCreateViewSql('assay_t1', 't1', { delim: ';' })).toBe(
      "CREATE VIEW \"assay_t1\" AS SELECT * FROM read_csv('t1', delim = ';')",
    )
  })
})

describe('effectiveCsvOptions — disclosure of what was actually composed', () => {
  it('echoes exactly the set options, canonically, JSON-able', () => {
    expect(effectiveCsvOptions({ delim: ';', header: true })).toEqual({ header: true, delim: ';' })
    expect(effectiveCsvOptions({ sample_size: -1, all_varchar: true })).toEqual({
      all_varchar: true,
      sample_size: -1,
    })
  })

  it('deep-copies the declared-columns map (the response must not alias the caller)', () => {
    const columns = { v: 'VARCHAR' }
    const effective = effectiveCsvOptions({ columns })
    expect(effective.columns).toEqual(columns)
    expect(effective.columns).not.toBe(columns)
  })

  it('an empty option set discloses an empty effective set (the bare scan)', () => {
    expect(effectiveCsvOptions({})).toEqual({})
  })
})

// ---- golden fixtures + manifest (repo fixture rule; ADR 0038 policy shape) ----

describe('fixtures/csv golden set — generator, checksums, manifest', () => {
  const GOLDEN = [
    'leading-zeros.csv',
    'quoted-empty.csv',
    'late-bad-row.csv',
    'semicolon.csv',
    'unsafe-int.csv',
    'dup-header.csv',
  ] as const

  function readManifest(): { files: Array<{ name: string; sha256: string }> } {
    return JSON.parse(readFileSync(join(CSV_FIXTURES, 'manifest.json'), 'utf8')) as {
      files: Array<{ name: string; sha256: string }>
    }
  }

  it('every manifest entry exists with a matching checksum (bidirectional: manifest → disk)', () => {
    const manifest = readManifest()
    const listed = new Set(manifest.files.map((file) => file.name))
    for (const name of GOLDEN) expect(listed.has(name), name).toBe(true)
    for (const file of manifest.files) {
      const bytes = readFileSync(join(CSV_FIXTURES, file.name))
      expect(createHash('sha256').update(bytes).digest('hex'), file.name).toBe(file.sha256)
    }
  })

  it('every generated golden fixture is listed (disk → manifest over the golden set)', () => {
    const manifest = readManifest()
    const listed = new Set(manifest.files.map((file) => file.name))
    for (const name of GOLDEN) expect(listed.has(name), name).toBe(true)
    // The generator script must exist beside the fixtures it regenerates.
    expect(existsSync(join(CSV_FIXTURES, 'generate.mjs'))).toBe(true)
    // The pre-existing hand fixtures stay OUT of the generated manifest's
    // golden set — regeneration never touches them.
    const onDisk = new Set(readdirSync(CSV_FIXTURES).filter((name) => name.endsWith('.csv')))
    for (const name of GOLDEN) expect(onDisk.has(name), name).toBe(true)
    expect(onDisk.has('customers.csv')).toBe(true)
    expect(listed.has('customers.csv')).toBe(false)
  })

  it('the fixtures carry the exact shapes the preview tests pin (leading zeros; semicolon; late bad row)', () => {
    const leadingZeros = readFileSync(join(CSV_FIXTURES, 'leading-zeros.csv'), 'utf8')
    expect(leadingZeros).toContain('0017')
    const semicolon = readFileSync(join(CSV_FIXTURES, 'semicolon.csv'), 'utf8')
    expect(semicolon).toContain('id;name;score')
    const lateBad = readFileSync(join(CSV_FIXTURES, 'late-bad-row.csv'), 'utf8').trimEnd()
    expect(lateBad.startsWith('n')).toBe(true)
    expect(lateBad.endsWith('abc')).toBe(true) // the bad token, last line
  })
})

// ---- CLI control (D15: the CLI is comparison only — the browser build is the
// capability truth; these legs prove the COMPOSED SQL is valid, readable and
// honest against a real DuckDB, never that a browser build accepted anything).
// Skips when the pinned CLI is absent (the export-boundary agreement pattern). ----

const DUCKDB_CLI = process.env['DUCKDB'] ?? '/tmp/duckdb'
const hasDuckDbCli = existsSync(DUCKDB_CLI)

describe('csvScanRelationSql against real DuckDB (CLI control; D15: comparison only)', () => {
  function runCli(sql: string): string {
    return execFileSync(DUCKDB_CLI, ['-c', sql], { encoding: 'utf8' })
  }

  function tmpFixturePath(name: string): string {
    return join(CSV_FIXTURES, name)
  }

  it.skipIf(!hasDuckDbCli)(
    'the composed scan runs and preserves the 0017 lexeme under all_varchar',
    () => {
      const options = parseCsvOptions(
        { all_varchar: true, header: true, sample_size: 5 },
        'preview',
      )
      if (!options.ok) throw new Error('fixture options must parse')
      const sql = `SELECT id, typeof(id) AS t FROM ${csvScanRelationSql(tmpFixturePath('leading-zeros.csv'), options.options)} LIMIT 3`
      const out = runCli(sql)
      expect(out).toContain('0017')
      expect(out).toContain('VARCHAR')
    },
  )

  it.skipIf(!hasDuckDbCli)('the composed semicolon scan reads the ; dialect via delim', () => {
    const options = parseCsvOptions({ delim: ';', header: true }, 'preview')
    if (!options.ok) throw new Error('fixture options must parse')
    const out = runCli(
      `SELECT count(*) AS n FROM ${csvScanRelationSql(tmpFixturePath('semicolon.csv'), options.options)}`,
    )
    expect(out).toContain('2')
  })

  it.skipIf(!hasDuckDbCli)(
    'the sniff SQL returns the disclosure columns the executor reads',
    () => {
      const options = parseCsvOptions({ sample_size: 5 }, 'preview')
      if (!options.ok) throw new Error('fixture options must parse')
      const out = runCli(csvSniffSql(tmpFixturePath('late-bad-row.csv'), options.options))
      expect(out).toContain('Delimiter')
      expect(out).toContain('HasHeader')
      expect(out).toContain('Prompt')
    },
  )

  it.skipIf(!hasDuckDbCli)('the sample SQL is bounded by its LIMIT (a sample, not a scan)', () => {
    const options = parseCsvOptions({}, 'preview')
    if (!options.ok) throw new Error('fixture options must parse')
    const out = runCli(csvSampleSql(tmpFixturePath('late-bad-row.csv'), options.options, 5))
    // 5 data rows past the header; the late bad token (last line) is not read.
    expect(out).toContain('5')
  })
})
