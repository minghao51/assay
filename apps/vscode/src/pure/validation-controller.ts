// SPDX-License-Identifier: AGPL-3.0-or-later

import { parseContract } from '@assay/contracts'
import { compileContract } from '@assay/validation'
import type { EngineValidationResult } from '@assay/engine-duckdb'

export const VALIDATION_RELATION = 'assay_validation_target'
export const VALIDATION_SAMPLE_LIMIT = 100
export const CONTRACT_MAX_BYTES = 1024 * 1024

export interface ValidationProjection {
  readonly revision: number
  readonly valid: boolean
  readonly rowCount: number
  readonly rules: readonly {
    readonly ruleId: string
    readonly failCount: number
    readonly failPercent: number
    readonly samples: readonly {
      readonly rowKey: string
      readonly value: string | number | boolean | null
    }[]
  }[]
}

export function projectValidation(
  result: EngineValidationResult,
  revision: number,
  limit = VALIDATION_SAMPLE_LIMIT,
): ValidationProjection {
  const bound = Number.isSafeInteger(limit)
    ? Math.max(0, Math.min(limit, VALIDATION_SAMPLE_LIMIT))
    : 0
  return {
    revision,
    valid: result.valid,
    rowCount: result.rowCount,
    rules: result.rules.map((rule) => ({
      ruleId: rule.ruleId,
      failCount: rule.failCount,
      failPercent: rule.failPercent,
      samples: rule.sampleFailures.slice(0, bound),
    })),
  }
}

export function isValidationStale(report: ValidationProjection | null, revision: number): boolean {
  return report !== null && report.revision !== revision
}

export function isCurrentValidationGeneration(requested: number, current: number): boolean {
  return Number.isSafeInteger(requested) && requested === current
}

export function acceptsValidationFrame(
  expected: { readonly id: string; readonly generation: number },
  message: unknown,
): message is {
  readonly kind: 'contract-loaded'
  readonly id: string
  readonly generation: number
  readonly text: string
} {
  if (typeof message !== 'object' || message === null) return false
  const frame = message as Record<string, unknown>
  return (
    frame['kind'] === 'contract-loaded' &&
    frame['id'] === expected.id &&
    frame['generation'] === expected.generation &&
    typeof frame['text'] === 'string' &&
    new TextEncoder().encode(frame['text']).byteLength <= CONTRACT_MAX_BYTES
  )
}

export function parseAndCompileContract(
  text: string,
  schema: readonly { readonly name: string; readonly type: string }[],
) {
  if (text.trim().length === 0) return { kind: 'empty' as const }
  if (new TextEncoder().encode(text).byteLength > CONTRACT_MAX_BYTES)
    return { kind: 'too-large' as const }
  const parsed = parseContract(text)
  if (!parsed.ok) return { kind: 'parse-error' as const }
  const compiled = compileContract(parsed.contract, schema, {
    relation: VALIDATION_RELATION,
    sampleLimit: VALIDATION_SAMPLE_LIMIT,
  })
  return compiled.ok
    ? { kind: 'compiled' as const, contract: parsed.contract, plan: compiled.plan }
    : { kind: 'compile-error' as const }
}
