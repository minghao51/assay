// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Total YAML → contract parser (m5-0).
 *
 * `parseContract` is **total**: any input yields either a {@link ContractV1}
 * or `ContractError[]` with line/column — never a raw throw (repo
 * never-throws convention; cf. the web type parser, the domain overlay
 * fold). Every malformed document produces typed, actionable errors
 * (`errors.ts` documents the taxonomy); see `validate.ts` for the walk.
 *
 * Implementation notes:
 * - The `yaml` library (MIT; the package's single runtime dependency) parses
 *   in *document* mode with `uniqueKeys: false` so duplicate keys survive to
 *   our own duplicate-rule validation with precise positions, instead of
 *   being silently overwritten (the honesty bar: nothing is dropped).
 * - Library parse *errors* and *warnings* both become `yaml-syntax`
 *   contract errors — a warning means the library silently coerced
 *   something (an unresolved tag, a fixed merge key), which this format
 *   refuses. On any syntax problem the document is not walked further.
 * - Anchors/aliases resolve to their values; canonical output is
 *   anchor-free. Alias *cycles* are rejected with a typed error rather than
 *   recursing forever.
 * - Error positions are visible-column aligned: a leading BOM is not
 *   counted as a character of line 1 (editors render it invisibly).
 * - **No input-size or nesting limit is enforced here, deliberately**: the
 *   parser stays total for any input, and input bounds belong to the
 *   callers that own file policy (contracts are small, locally authored
 *   files; an arbitrary byte cap at this layer would be an unqueued product
 *   decision). Surfaces feeding `parseContract` (editor, CLI, adapters)
 *   should apply their own size limits.
 */
import { parseDocument } from 'yaml'
import type { ContractError, ContractParseResult } from './errors.js'
import { offsetToLineCol, makeLineIndex, validateContractDocument } from './validate.js'

/**
 * Parse a contract document (YAML text). Total over all inputs: for
 * non-string input (a caller bug) it still returns a typed error instead of
 * throwing.
 */
export function parseContract(text: string): ContractParseResult {
  if (typeof text !== 'string') {
    return {
      ok: false,
      errors: [
        {
          code: 'wrong-type',
          message: 'the contract source must be a string of YAML text',
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
    // parseDocument is designed to collect problems instead of throwing;
    // this guard keeps the totality promise even against library surprises.
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
  const errors: ContractError[] = []
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
          message: 'the document is empty — expected a contract mapping starting with "format: v1"',
          path: 'document',
          line: 1,
          column: 1,
        },
      ],
    }
  }

  const { contract, errors: walkErrors } = validateContractDocument(doc, text)
  if (walkErrors.length > 0) return { ok: false, errors: walkErrors }
  return contract !== undefined
    ? { ok: true, contract }
    : {
        ok: false,
        errors: [
          {
            code: 'wrong-type',
            message:
              'the document is empty — expected a contract mapping starting with "format: v1"',
            path: 'document',
            line: 1,
            column: 1,
          },
        ],
      }
}
