// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Starter-contract builder (ug-20/UG-28) — the validation zero-state on-ramp.
 *
 * The open dataset's effective schema is projected into a small, canonical
 * `ContractV1` draft: one declared-type rule per column whose engine spelling
 * maps confidently into the closed v1 vocabulary. Everything else is left
 * out — a starter contract that guessed at nested/parameterized/unknown
 * types would be worse than no rule at all. The draft is a starting point to
 * edit, never something the app imports on the user's behalf.
 *
 * Privacy (ADR 0025): the contract is built from column names and types only.
 * It never carries the dataset's file name, row values, or other content.
 *
 * Delivery is deliberately outside this module: the panel injects the
 * hidden-anchor download (the report-export discipline) so the builder stays
 * pure and Node-testable.
 */
import { CONTRACT_FORMAT, contractTypeHint, isKnownContractType } from '@assay/contracts'
import type { ContractTypeSpelling, ContractV1 } from '@assay/contracts'
import { serializeContract } from '@assay/contracts'

/** Fixed new-file name — never derived from the opened dataset (ADR 0025). */
export const STARTER_CONTRACT_FILE_NAME = 'assay-starter-contract.yaml'

/** The metadata name is fixed too; it is not the dataset's name. */
const STARTER_CONTRACT_NAME = 'starter-contract'
const STARTER_CONTRACT_VERSION = 1
const STARTER_CONTRACT_MIN_ROWS = 1

/** DuckDB's canonical parameterized decimal spelling (no spaces). */
const DECIMAL_PARAMS = /^DECIMAL\((\d+),(\d+)\)$/
/** DuckDB's accepted VARCHAR length modifier (classified only when valid). */
const VARCHAR_PARAMS = /^VARCHAR\((\d+)\)$/
const MAX_DECIMAL_PRECISION = 38

export interface StarterContractColumn {
  readonly name: string
  readonly type: string
}

export interface StarterContract {
  readonly text: string
  readonly fileName: string
}

/**
 * Map one engine type spelling to a vocabulary spelling, or `null` when the
 * projection cannot be made confidently. Canonical spellings win first;
 * documented aliases are matched exactly (never lowercased/fuzzy-matched),
 * and the parameterized DECIMAL/VARCHAR forms map to the bare vocabulary
 * spelling the v1 format can actually express. Arrays, nested types, invalid
 * parameters and unknown spellings are omitted rather than guessed.
 */
function contractTypeFor(type: string): ContractTypeSpelling | null {
  if (isKnownContractType(type)) return type

  const alias = contractTypeHint(type)
  if (alias !== null) return alias

  const decimal = DECIMAL_PARAMS.exec(type)
  if (decimal !== null) {
    const precision = Number(decimal[1])
    const scale = Number(decimal[2])
    if (precision >= 1 && precision <= MAX_DECIMAL_PRECISION && scale <= precision) {
      return 'DECIMAL'
    }
    return null
  }

  const varchar = VARCHAR_PARAMS.exec(type)
  if (varchar !== null) {
    const length = Number(varchar[1])
    if (Number.isSafeInteger(length) && length >= 0) return 'VARCHAR'
    return null
  }

  return null
}

/**
 * Build the canonical starter-contract text for a schema. `null` means there
 * is nothing to start from (an empty/unavailable schema); a non-empty schema
 * with no confidently mappable columns still yields a valid document with
 * dataset rules only.
 */
export function buildStarterContract(
  schema: readonly StarterContractColumn[],
): StarterContract | null {
  if (schema.length === 0) return null

  const columns = schema.flatMap((column) => {
    const type = contractTypeFor(column.type)
    return type === null ? [] : [{ name: column.name, type }]
  })

  const contract: ContractV1 = {
    format: CONTRACT_FORMAT,
    metadata: { name: STARTER_CONTRACT_NAME, version: STARTER_CONTRACT_VERSION },
    columns,
    dataset: { minRows: STARTER_CONTRACT_MIN_ROWS },
  }

  // The canonical serializer guarantees the bytes are deterministic and the
  // document re-parses; the unit pins hold both properties.
  return { text: serializeContract(contract), fileName: STARTER_CONTRACT_FILE_NAME }
}
