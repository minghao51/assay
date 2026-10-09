// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Total YAML → DCR artifact parser (p3-1; ADR 0046).
 *
 * `parseDcr` is **total** over document-level inputs: any malformed document
 * yields either a {@link DcrArtifactV1} or `DcrError[]` with line/column —
 * never a raw throw (repo never-throws convention; mirrors `parsePipeline`).
 * The one deliberate exception is a `RangeError` from the YAML resolver's
 * deep-nesting recursion: a resource-limit failure, not a document error,
 * so it propagates rather than being swallowed.
 *
 * Implementation notes (mirroring the IR parser):
 * - The `yaml` library parses in *document* mode with `uniqueKeys: false`,
 *   so duplicate keys survive to our own duplicate-key validation with
 *   precise positions instead of being silently overwritten.
 * - Library parse errors *and* warnings both become `yaml-syntax` errors —
 *   a warning means the library silently coerced something (an unresolved
 *   tag), which this format refuses.
 * - Anchors/aliases resolve to their values; canonical output is anchor-free.
 *   Alias cycles are rejected with a typed error rather than recursing.
 * - Numbers are **exact or rejected**; the reserved `assay_dcr_*` namespace
 *   is refused in id positions; row-diff sample keys must match the
 *   anchor-free export grammar (see `dcr-validate.ts`).
 * - Error positions are visible-column aligned (a leading BOM is not
 *   counted).
 *
 * Purity: no React, no browser APIs, no engine (lint-enforced).
 */
import { parseDocument } from 'yaml'
import type { DcrError, DcrParseResult } from './dcr-errors.js'
import { makeLineIndex, offsetToLineCol } from './validate.js'
import { validateDcrDocument } from './dcr-validate.js'

/**
 * Parse a DCR artifact document (YAML text). Total over all inputs: for
 * non-string input (a caller bug) it still returns a typed error.
 */
export function parseDcr(text: string): DcrParseResult {
  if (typeof text !== 'string') {
    return {
      ok: false,
      errors: [
        {
          code: 'wrong-type',
          message: 'the DCR artifact source must be a string of YAML text',
          path: 'document',
          line: 1,
          column: 1,
        },
      ],
    }
  }

  let doc
  try {
    doc = parseDocument(text, { uniqueKeys: false })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      errors: [
        {
          code: 'yaml-syntax',
          message: `YAML syntax error: ${message}`,
          path: 'document',
          line: 1,
          column: 1,
        },
      ],
    }
  }

  const lineIndex = makeLineIndex(text)
  const errors: DcrError[] = []
  const pushSyntax = (problem: { message: string; pos?: readonly [number, number] }): void => {
    const offset = problem.pos?.[0] ?? 0
    const { line, column } = offsetToLineCol(lineIndex, offset)
    errors.push({
      code: 'yaml-syntax',
      message: `YAML syntax error: ${problem.message}`,
      path: 'document',
      line,
      column,
    })
  }
  for (const error of doc.errors) pushSyntax(error)
  for (const warning of doc.warnings) pushSyntax(warning)
  if (errors.length > 0) return { ok: false, errors }

  if (doc.contents === null || doc.contents === undefined) {
    return {
      ok: false,
      errors: [
        {
          code: 'wrong-type',
          message:
            'the document is empty — expected a DCR artifact mapping starting with "format: assay-dcr"',
          path: 'document',
          line: 1,
          column: 1,
        },
      ],
    }
  }

  const { artifact, errors: walkErrors } = validateDcrDocument(doc, text, lineIndex)
  if (walkErrors.length > 0) return { ok: false, errors: walkErrors }
  return artifact !== undefined
    ? { ok: true, artifact }
    : {
        ok: false,
        errors: [
          {
            code: 'wrong-type',
            message:
              'the document is empty — expected a DCR artifact mapping starting with "format: assay-dcr"',
            path: 'document',
            line: 1,
            column: 1,
          },
        ],
      }
}
