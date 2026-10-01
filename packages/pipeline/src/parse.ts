// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Total YAML → Pipeline IR parser (p-1).
 *
 * `parsePipeline` is **total** over document-level inputs: any malformed
 * document yields either a {@link PipelineV1} or `PipelineError[]` with
 * line/column — never a raw throw (repo never-throws convention; cf.
 * `@assay/contracts`). The one deliberate exception is a `RangeError` from
 * the YAML resolver's deep-nesting recursion (p2-1 (f)): a resource-limit
 * failure, not a document error, so it propagates rather than being
 * swallowed. Every malformed document produces typed, actionable errors
 * (`errors.ts` documents the taxonomy); see `validate.ts` for the walk.
 *
 * Implementation notes:
 * - The `yaml` library parses in *document* mode with `uniqueKeys: false`, so
 *   duplicate keys survive to our own duplicate-key validation with precise
 *   positions instead of being silently overwritten.
 * - Library parse errors *and* warnings both become `yaml-syntax` errors — a
 *   warning means the library silently coerced something (an unresolved tag),
 *   which this format refuses. There is no merge-key feature: this is a YAML
 *   1.2-core document, where `<<` is an ordinary mapping key carried as data
 *   (pinned in `parse.test.ts`).
 * - Anchors/aliases resolve to their values; canonical output is anchor-free.
 *   Alias cycles are rejected with a typed error rather than recursing.
 * - Numbers are **exact or rejected** (p-2): every numeric literal is checked
 *   against the reused `@assay/contracts` policy, so a written value is never
 *   silently altered by the YAML→number parse; and node ids using the
 *   reserved `assay_*` namespace are refused (`reserved-identifier`) because
 *   a node id becomes a relation name (see `validate.ts`).
 * - Error positions are visible-column aligned (a leading BOM is not counted).
 * - No input-size or nesting limit is enforced here, deliberately: the parser
 *   stays total for any input; bounds belong to the surfaces that own file
 *   policy.
 *
 * Purity: no React, no browser APIs, no engine, no `@assay/*` imports beyond
 * the allowed set (lint-enforced).
 */
import { parseDocument } from 'yaml'
import type { PipelineError, PipelineParseResult } from './errors.js'
import { makeLineIndex, offsetToLineCol, validatePipelineDocument } from './validate.js'

/**
 * Parse a pipeline document (YAML text). Total over all inputs: for
 * non-string input (a caller bug) it still returns a typed error.
 */
export function parsePipeline(text: string): PipelineParseResult {
  if (typeof text !== 'string') {
    return {
      ok: false,
      errors: [
        {
          code: 'wrong-type',
          message: 'the pipeline source must be a string of YAML text',
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
  const errors: PipelineError[] = []
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
          message: 'the document is empty — expected a pipeline mapping starting with "version: 1"',
          path: 'document',
          line: 1,
          column: 1,
        },
      ],
    }
  }

  const { pipeline, errors: walkErrors } = validatePipelineDocument(doc, text)
  if (walkErrors.length > 0) return { ok: false, errors: walkErrors }
  return pipeline !== undefined
    ? { ok: true, pipeline }
    : {
        ok: false,
        errors: [
          {
            code: 'wrong-type',
            message:
              'the document is empty — expected a pipeline mapping starting with "version: 1"',
            path: 'document',
            line: 1,
            column: 1,
          },
        ],
      }
}
