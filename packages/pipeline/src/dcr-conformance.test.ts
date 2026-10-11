// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * p3-5 conformance sweep over the committed DCR corpus (`fixtures/dcr/`):
 *
 * - **Round-trip sweep**: every committed fixture on disk is parsed and
 *   re-serialized; canonical fixtures must be byte-identical, the deliberate
 *   non-canonical rendering must canonicalize to its target, and the
 *   manifest's parse/refuse classification must match what the parser
 *   actually does (disk-driven, so a fixture missing from the manifest is
 *   caught here independently of the manifest pins).
 * - **Corrupt-variant sweep**: deterministic corruption classes (truncation,
 *   slice deletion, garbage injection, scalar quoting, key mangling, quote
 *   stripping, stamp duplication) applied to every parsing fixture — the
 *   parser is total (never throws) and every reported error is *located*
 *   (code, path, 1-based line/column). Survivors satisfy the canonical
 *   fixpoint.
 * - **Additive-only guard (D17-Q12)**: unknown keys at every section of a
 *   real artifact are refused with the version-stamped error, and the closed
 *   enum vocabularies (OQ-1) reject non-members while accepting exactly
 *   their exported members — the allowlist the parser reports equals the
 *   exported grammar constants.
 * - **Reserved-namespace sweep (D17-Q9)**: `assay_dcr_*` is refused
 *   case-insensitively at every id position of the real corpus documents,
 *   while user-data positions (datasetId / versionId / inputVersionIds)
 *   deliberately still accept such values — the reservation must not
 *   overreach.
 *
 * Generated probes are single-issue: one defect on an otherwise canonical
 * minimal artifact whose privacy disclosure is the exact canonical sentence.
 * Value-free throughout (ADR 0025): probes use format vocabulary and
 * synthetic ids only.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DCR_COLUMN_FAMILIES,
  DCR_PRIVACY_NOT_COMPUTED_DISCLOSURE,
  DCR_PROFILE_COLUMN_KINDS,
  DCR_ROW_DIFF_ASPECTS,
  DCR_SCHEMA_DRIFT_KINDS,
} from './dcr-ast.js'
import { parseDcr } from './dcr-parse.js'
import { serializeDcr } from './dcr-serialize.js'

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/dcr')

interface ManifestEntry {
  readonly name: string
  readonly sha256: string
  readonly canonical?: boolean
  readonly canonicalizesTo?: string
  readonly expect?: 'parses' | 'refuses'
  readonly errorCode?: string
}
interface Manifest {
  readonly files: readonly ManifestEntry[]
}
const manifest = JSON.parse(readFileSync(join(FIXTURE_DIR, 'manifest.json'), 'utf8')) as Manifest
const manifestByName = new Map(manifest.files.map((entry) => [entry.name, entry]))

/** Every committed fixture, walked from disk — not from the manifest. */
function corpusFiles(): readonly string[] {
  return readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith('.yaml'))
    .sort()
}

function corpusText(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf8')
}

/** The fixtures that must parse (everything except the refuses-* probes). */
function parsingCorpusFiles(): readonly string[] {
  return corpusFiles().filter((name) => manifestByName.get(name)?.expect !== 'refuses')
}

/**
 * A minimal canonical artifact carrying exactly the given `deltas:` block —
 * the host for single-issue enum probes.
 */
function artifactDoc(deltasBlock: string): string {
  return `format: assay-dcr
version: 1
base:
  datasetId: dataset-a
  versionId: version-a-1
  schemaFingerprint:
    algorithm: assay-schema-fingerprint-v1
    value: fp-a-0001
  materialization:
    node: src_orders
candidate:
  datasetId: dataset-a
  versionId: version-a-2
  schemaFingerprint:
    algorithm: assay-schema-fingerprint-v1
    value: fp-a-0002
  materialization:
    export: exports/run-2/out.parquet
deltas:
${deltasBlock}
privacyFindings:
  status: not-computed
  disclosure: "${DCR_PRIVACY_NOT_COMPUTED_DISCLOSURE}"
`
}

/**
 * Totality + location pin for one corrupted document: `parseDcr` never
 * throws; every error carries a code, a path, and 1-based line/column;
 * whatever still parses satisfies the canonical fixpoint.
 */
function expectTotalAndLocated(text: string, label: string): void {
  let result: ReturnType<typeof parseDcr> | undefined
  expect(() => {
    result = parseDcr(text)
  }, label).not.toThrow()
  if (result === undefined) throw new Error('unreachable: parseDcr always returns')
  if (!result.ok) {
    expect(result.errors.length, label).toBeGreaterThan(0)
    for (const error of result.errors) {
      expect(error.code.length, `${label} (${error.path})`).toBeGreaterThan(0)
      expect(error.path.length, label).toBeGreaterThan(0)
      expect(error.line, `${label} (${error.code})`).toBeGreaterThanOrEqual(1)
      expect(error.column, `${label} (${error.code})`).toBeGreaterThanOrEqual(1)
    }
    return
  }
  const once = serializeDcr(result.artifact)
  const reparsed = parseDcr(once)
  expect(reparsed, label).toEqual({ ok: true, artifact: result.artifact })
  expect(serializeDcr(reparsed.ok ? reparsed.artifact : result.artifact), label).toBe(once)
}

describe('p3-5 round-trip sweep: every committed fixture parses and re-serializes byte-identically', () => {
  it('sweeps every fixture on disk, cross-classified against the manifest', () => {
    const files = corpusFiles()
    expect(files.length).toBeGreaterThan(0)
    for (const name of files) {
      // Independent manifest-completeness check: the sweep must never
      // silently cover an unlisted fixture (the manifest pins assert the
      // reverse direction — no listed name without a file).
      const entry = manifestByName.get(name)
      expect(entry, `${name} is listed in manifest.json`).toBeDefined()

      const text = corpusText(name)
      const parsed = parseDcr(text)
      if (entry?.expect === 'refuses') {
        expect(parsed.ok, name).toBe(false)
        if (!parsed.ok) {
          expect(
            parsed.errors.map((error) => error.code),
            name,
          ).toEqual([entry.errorCode])
        }
        continue
      }
      expect(parsed.ok, name).toBe(true)
      if (!parsed.ok) continue

      const canonical = serializeDcr(parsed.artifact)
      if (entry?.canonical) expect(text, `${name} is canonical bytes`).toBe(canonical)
      const reparsed = parseDcr(canonical)
      expect(reparsed, name).toEqual({ ok: true, artifact: parsed.artifact })
      expect(serializeDcr(reparsed.ok ? reparsed.artifact : parsed.artifact), name).toBe(canonical)
      if (entry?.canonicalizesTo !== undefined) {
        expect(canonical, `${name} canonicalizes to ${entry.canonicalizesTo}`).toBe(
          corpusText(entry.canonicalizesTo),
        )
      }
    }
  })

  it('the corpus includes the artifact set, with the CLI golden swept end-to-end', () => {
    const files = corpusFiles()
    // The sweep is only honest if it really covers the committed artifacts —
    // including the p3-3 golden the real CLI path minted (its bytes are the
    // end-to-end proof the corpus and the CLI agree).
    for (const required of [
      'minimal.yaml',
      'gated-run.yaml',
      'gated-run-alternate.yaml',
      'bounded-topk.yaml',
      'cli-gated-run.yaml',
    ]) {
      expect(files, `${required} is part of the swept corpus`).toContain(required)
    }
    const golden = parseDcr(corpusText('cli-gated-run.yaml'))
    expect(golden.ok).toBe(true)
    if (!golden.ok) return
    // Byte-identical round trip: CLI-minted bytes are canonical bytes.
    expect(serializeDcr(golden.artifact)).toBe(corpusText('cli-gated-run.yaml'))
  })
})

describe('p3-5 corrupt-variant sweep: located errors, never throws', () => {
  const PARSING = parsingCorpusFiles()

  /** Deterministic corruption classes over one fixture text. */
  function corruptVariants(
    text: string,
  ): readonly { readonly label: string; readonly text: string }[] {
    const variants: { label: string; text: string }[] = []
    for (let k = 1; k < 12; k++) {
      const at = Math.floor((text.length * k) / 12)
      variants.push({ label: `truncate@${at}`, text: text.slice(0, at) })
    }
    for (let k = 0; k < 10; k++) {
      const at = Math.floor((text.length * k) / 10)
      variants.push({ label: `delete-slice@${at}`, text: text.slice(0, at) + text.slice(at + 8) })
    }
    const garbage = ['"', '{', '[', ':', '\t', '@', '---', 'null', '.inf', '\u0000']
    for (let k = 0; k < garbage.length; k++) {
      const at = Math.floor((text.length * k) / garbage.length)
      variants.push({
        label: `inject ${JSON.stringify(garbage[k])}@${at}`,
        text: text.slice(0, at) + (garbage[k] ?? '') + text.slice(at),
      })
    }
    // Type corruption: quote a written number so the YAML type no longer
    // matches the key's domain (first six numeric lines).
    const lines = text.split('\n')
    const numericIndices = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => /^\s*[A-Za-z_][A-Za-z0-9_]*:\s*-?\d+(?:\.\d+)?\s*$/.test(line))
      .map(({ index }) => index)
    for (const index of numericIndices.slice(0, 6)) {
      const mutated = [...lines]
      mutated[index] = (lines[index] ?? '').replace(
        /^(\s*[A-Za-z_][A-Za-z0-9_]*:\s*)(-?\d+(?:\.\d+)?)$/,
        '$1"$2"',
      )
      variants.push({ label: `quote-number:L${index + 1}`, text: mutated.join('\n') })
    }
    // Key mangling: a lookalike misspelling at each mapping-key position
    // (first eight) must stay an unknown key, never a silent accept.
    const keyIndices = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => /^\s*[A-Za-z_][A-Za-z0-9_]*:/.test(line))
      .map(({ index }) => index)
    for (const index of keyIndices.slice(0, 8)) {
      const mutated = [...lines]
      mutated[index] = (lines[index] ?? '').replace(/^(\s*)([A-Za-z_][A-Za-z0-9_]*):/, '$1$2_:')
      variants.push({ label: `mangle-key:L${index + 1}`, text: mutated.join('\n') })
    }
    // Quote stripping: a quoted scalar loses its quoting (type corruption).
    if (text.includes('"'))
      variants.push({ label: 'strip-double-quotes', text: text.replaceAll('"', '') })
    if (text.includes("'"))
      variants.push({ label: 'strip-single-quote', text: text.replace("'", '') })
    // Duplicate the format stamp — a duplicate key at the root.
    variants.push({
      label: 'duplicate-format',
      text: text.replace('format: assay-dcr', 'format: assay-dcr\nformat: assay-dcr'),
    })
    return variants
  }

  for (const name of PARSING) {
    it(`${name}: every corruption variant is total and located`, () => {
      const text = corpusText(name)
      for (const variant of corruptVariants(text)) {
        expectTotalAndLocated(variant.text, `${name}/${variant.label}`)
      }
    })
  }
})

describe('p3-5 additive-only guard (D17-Q12): unknown keys are refused, version-stamped', () => {
  const GATED = corpusText('gated-run.yaml')

  /**
   * Insert an unknown key line after the anchor line (matched as a whole
   * line), at the given indent. The anchor must match exactly one line.
   */
  function insertUnknownKey(anchor: string, indent: string): string {
    const lines = GATED.split('\n')
    const hits = lines.map((line, index) => ({ line, index })).filter(({ line }) => line === anchor)
    expect(
      hits.map(({ index }) => index),
      `anchor is a unique line: ${JSON.stringify(anchor)}`,
    ).toHaveLength(1)
    const at = hits[0]?.index ?? -1
    lines.splice(at + 1, 0, `${indent}zzzProbe: 1`)
    return lines.join('\n')
  }

  // Every section of a real artifact, probed with an unknown key: the
  // [anchor, indent, expected path] table walks the whole grammar depth.
  const POSITIONS: readonly (readonly [string, string, string])[] = [
    ['base:', '  ', 'base'],
    ['    value: fp-7f3a', '    ', 'base.schemaFingerprint'],
    ['candidate:', '  ', 'candidate'],
    ['    value: fp-8c2d', '    ', 'candidate.schemaFingerprint'],
    ['deltas:', '  ', 'deltas'],
    ['      familyB: textual', '      ', 'deltas.schemaDrift[0]'],
    ['      numeric:', '        ', 'deltas.columnDeltas[0].numeric'],
    ['  rowDiff:', '    ', 'deltas.rowDiff'],
    ['      - aspect: added', '        ', 'deltas.rowDiff.aspects[0]'],
    ['            rowKey: b:1000', '            ', 'deltas.rowDiff.aspects[0].samples[0]'],
    ['    rowCount: 1002', '    ', 'validation[0]'],
    ['        failPercent: 100', '        ', 'validation[0].rules[0]'],
    ['lineage:', '  ', 'lineage'],
    ['privacyFindings:', '  ', 'privacyFindings'],
  ]

  for (const [anchor, indent, path] of POSITIONS) {
    it(`an unknown key inside ${path} is refused with the v1 stamp`, () => {
      const parsed = parseDcr(insertUnknownKey(anchor, indent))
      expect(parsed.ok, path).toBe(false)
      if (parsed.ok) return
      expect(
        parsed.errors.map((error) => error.code),
        path,
      ).toEqual(['unknown-key'])
      expect(parsed.errors[0]?.path, path).toBe(path)
      expect(parsed.errors[0]?.message, path).toContain('DCR artifact v1')
      expect(parsed.errors[0]?.message, path).toContain('additive-only')
    })
  }

  it('an unknown key at the document root is refused with the v1 stamp', () => {
    const parsed = parseDcr(`${GATED}\nzzzProbe: 1`)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.errors.map((error) => error.code)).toEqual(['unknown-key'])
    expect(parsed.errors[0]?.message).toContain('DCR artifact v1')
  })

  it('a lookalike misspelling of a known key is still an unknown key', () => {
    const parsed = parseDcr(GATED.replace('  rowDiff:', '  rowDiffx:'))
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.errors[0]?.code).toBe('unknown-key')
  })
})

describe('p3-5 enum closure (D19-OQ-1): closed vocabularies accept exactly their members', () => {
  /** The allowlist a non-member probe reports back, as an ordered list. */
  function reportedAllowlist(message: string): readonly string[] {
    const match = /expected one of: (.+)$/.exec(message)
    expect(match, 'the refusal names the closed vocabulary').not.toBeNull()
    return (match?.[1] ?? '').split(', ')
  }

  describe('schemaDrift kinds', () => {
    for (const kind of DCR_SCHEMA_DRIFT_KINDS) {
      it(`accepts the exported member "${kind}"`, () => {
        const parsed = parseDcr(
          artifactDoc(`  schemaDrift:
    - kind: ${kind}
      column: alpha`),
        )
        expect(parsed.ok, `member ${kind} parses`).toBe(true)
      })
    }

    it('refuses a non-member and reports exactly the exported vocabulary', () => {
      const parsed = parseDcr(
        artifactDoc(`  schemaDrift:
    - kind: x-${DCR_SCHEMA_DRIFT_KINDS[0]}
      column: alpha`),
      )
      expect(parsed.ok).toBe(false)
      if (parsed.ok) return
      expect(parsed.errors.map((error) => error.code)).toEqual(['out-of-range'])
      expect(reportedAllowlist(parsed.errors[0]?.message ?? '')).toEqual([
        ...DCR_SCHEMA_DRIFT_KINDS,
      ])
    })
  })

  describe('rowDiff aspects', () => {
    const ROW_DIFF = (aspects: readonly string[]): string => `  rowDiff:
    keys: [ k ]
    sampleLimit: 5
    rowCountA: 1
    rowCountB: 1
    aspects:
${aspects.map((aspect) => `      - aspect: ${aspect}\n        count: 0\n        samples: []`).join('\n')}`

    it('accepts every exported member — exactly one block per aspect, each once', () => {
      // The exactly-three-spelled grammar (one block per aspect) parses when
      // every member is the exported vocabulary — in canonical order…
      expect(parseDcr(artifactDoc(ROW_DIFF([...DCR_ROW_DIFF_ASPECTS]))).ok).toBe(true)
      // …and rotated (the walk normalizes into canonical order).
      expect(parseDcr(artifactDoc(ROW_DIFF([...DCR_ROW_DIFF_ASPECTS].reverse()))).ok).toBe(true)
    })

    it('refuses a non-member and reports exactly the exported vocabulary', () => {
      const [first, second, third] = DCR_ROW_DIFF_ASPECTS
      const parsed = parseDcr(
        artifactDoc(ROW_DIFF([`x-${first ?? 'added'}`, second ?? 'removed', third ?? 'changed'])),
      )
      expect(parsed.ok).toBe(false)
      if (parsed.ok) return
      expect(parsed.errors.map((error) => error.code)).toEqual(['out-of-range'])
      expect(reportedAllowlist(parsed.errors[0]?.message ?? '')).toEqual([...DCR_ROW_DIFF_ASPECTS])
    })
  })

  it('profile column kinds (kindA/kindB): a non-member is refused and reports exactly the exported vocabulary', () => {
    const parsed = parseDcr(
      artifactDoc(`  columnDeltas:
    - column: alpha
      typeA: VARCHAR
      typeB: VARCHAR
      kindA: x-${DCR_PROFILE_COLUMN_KINDS[0]}
      kindB: ${DCR_PROFILE_COLUMN_KINDS[0]}`),
    )
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.errors.map((error) => error.code)).toEqual(['out-of-range'])
    expect(reportedAllowlist(parsed.errors[0]?.message ?? '')).toEqual([
      ...DCR_PROFILE_COLUMN_KINDS,
    ])
  })

  it('type families (familyA): a non-member is refused and reports exactly the exported vocabulary', () => {
    const parsed = parseDcr(
      artifactDoc(`  schemaDrift:
    - kind: type-changed-cross-family
      column: alpha
      typeA: INTEGER
      typeB: VARCHAR
      familyA: x-${DCR_COLUMN_FAMILIES[0]}
      familyB: ${DCR_COLUMN_FAMILIES[1]}`),
    )
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.errors.map((error) => error.code)).toEqual(['out-of-range'])
    expect(reportedAllowlist(parsed.errors[0]?.message ?? '')).toEqual([...DCR_COLUMN_FAMILIES])
  })

  it('privacyFindings status: the only v1 member is "not-computed" — a lookalike is refused', () => {
    const parsed = parseDcr(`format: assay-dcr
version: 1
base:
  datasetId: dataset-a
  versionId: version-a-1
  schemaFingerprint:
    algorithm: assay-schema-fingerprint-v1
    value: fp-a-0001
  materialization:
    node: src_orders
candidate:
  datasetId: dataset-a
  versionId: version-a-2
  schemaFingerprint:
    algorithm: assay-schema-fingerprint-v1
    value: fp-a-0002
  materialization:
    export: exports/run-2/out.parquet
deltas: {}
privacyFindings:
  status: not-computedx
  disclosure: "${DCR_PRIVACY_NOT_COMPUTED_DISCLOSURE}"
`)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.errors.map((error) => error.code)).toEqual(['out-of-range'])
  })
})

describe('p3-5 reserved-namespace sweep (D17-Q9): assay_dcr_ stays out of id positions, both cases', () => {
  const GATED = corpusText('gated-run.yaml')
  const MINIMAL = corpusText('minimal.yaml')
  // Case variants: the reservation is case-insensitive by ruling.
  const VARIANTS = ['assay_dcr_probed', 'ASSAY_DCR_PROBED', 'Assay_Dcr_Probed'] as const

  /** The minimal artifact's user-data positions deliberately accept the namespace. */
  it('user-data positions (datasetId, versionId, inputVersionIds) still accept assay_dcr_ values', () => {
    const userData = MINIMAL.replace('datasetId: dataset-a', 'datasetId: assay_dcr_user_dataset')
      .replace('versionId: version-a-1', 'versionId: Assay_Dcr_User_Version')
      .replace('versionId: version-a-2', 'versionId: ASSAY_DCR_USER_VERSION_2')
    expect(parseDcr(userData).ok, 'datasetId/versionId are user data, not reserved').toBe(true)

    const parents = GATED.replace(
      'inputVersionIds: [ orders-v6, orders-v7 ]',
      'inputVersionIds: [ assay_dcr_parent, orders-v7 ]',
    )
    expect(parseDcr(parents).ok, 'inputVersionIds are user data, not reserved').toBe(true)
  })

  for (const variant of VARIANTS) {
    it(`refuses "${variant}" at base.materialization.node`, () => {
      const parsed = parseDcr(MINIMAL.replace('node: src_orders', `node: ${variant}`))
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) {
        expect(parsed.errors.map((error) => error.code)).toEqual(['reserved-identifier'])
        expect(parsed.errors[0]?.path).toBe('base.materialization.node')
      }
    })

    it(`refuses "${variant}" at candidate.materialization.node`, () => {
      const parsed = parseDcr(GATED.replace('node: candidate_orders', `node: ${variant}`))
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) {
        expect(parsed.errors.map((error) => error.code)).toEqual(['reserved-identifier'])
        expect(parsed.errors[0]?.path).toBe('candidate.materialization.node')
      }
    })

    it(`refuses "${variant}" at validation[0].nodeId`, () => {
      const parsed = parseDcr(GATED.replace('nodeId: check_min_rows', `nodeId: ${variant}`))
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) {
        expect(parsed.errors.map((error) => error.code)).toEqual(['reserved-identifier'])
        expect(parsed.errors[0]?.path).toBe('validation[0].nodeId')
      }
    })

    it(`refuses "${variant}" at lineage.nodes[0]`, () => {
      const parsed = parseDcr(
        GATED.replace('nodes: [ base_orders, filter_recent', `nodes: [ ${variant}, filter_recent`),
      )
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) {
        expect(parsed.errors.map((error) => error.code)).toEqual(['reserved-identifier'])
        expect(parsed.errors[0]?.path).toBe('lineage.nodes[0]')
      }
    })
  }

  it('the parsing corpus sweeps clean: no committed artifact carries a reserved id', () => {
    for (const name of parsingCorpusFiles()) {
      const parsed = parseDcr(corpusText(name))
      expect(parsed.ok, name).toBe(true)
      if (!parsed.ok) {
        expect(
          parsed.errors.map((error) => error.code),
          name,
        ).not.toContain('reserved-identifier')
      }
    }
  })
})
