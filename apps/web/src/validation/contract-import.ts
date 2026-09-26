// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Contract import (m5-3) — the text-side half of bringing a data contract
 * into the app. A contract is a small, locally authored YAML **text** file:
 * it is read as text in the app and parsed by `@assay/contracts`' total
 * parser — it never travels the engine's dataset pipeline, and a `.yaml`
 * file chosen in the contract picker is interpreted as a CONTRACT, not a
 * dataset (the panel says so in its copy).
 *
 * The parser is total over any input but deliberately enforces no size
 * bound (that policy belongs to surfaces that own file handling — see the
 * m5-0 parser doc), so this surface applies one: contracts are authored by
 * hand or generated from schemas; a megabyte of YAML is not a contract, and
 * reading unbounded text into the main thread on a click is a bad trade.
 * The bound is checked from the picked `File`'s size BEFORE any read.
 */

/**
 * The largest contract this surface will read. 1 MiB is orders of magnitude
 * above any real v1 contract (a rule is one short YAML mapping); the bound
 * is a main-thread safety rail, not a format rule.
 */
export const MAX_CONTRACT_BYTES = 1024 * 1024

/** Honest rejection copy for an over-bound contract (no file name — ADR 0025). */
export const CONTRACT_TOO_LARGE_MESSAGE =
  `That file is larger than ${String(MAX_CONTRACT_BYTES)} bytes — Assay reads contracts as ` +
  'text and accepts at most 1 MiB of YAML. Nothing was loaded.'

/** The slice of a picked file the import needs (structural; fakes allowed). */
export interface ContractFileLike {
  readonly size: number
  text(): Promise<string>
}

/** A contract import outcome: parsed contract, typed parse errors, or over-bound. */
export type ContractImportResult =
  | { readonly kind: 'too-large' }
  | { readonly kind: 'parsed'; readonly text: string }
  | { readonly kind: 'read-failed'; readonly message: string }

/**
 * Read a picked contract file as text, enforcing the size bound before any
 * byte is read. Read failures (a moved/revoked handle) degrade to a typed
 * outcome with a readable message — never a raw throw into the render path.
 */
export async function readContractFile(file: ContractFileLike): Promise<ContractImportResult> {
  if (file.size > MAX_CONTRACT_BYTES) return { kind: 'too-large' }
  try {
    return { kind: 'parsed', text: await file.text() }
  } catch (error) {
    return {
      kind: 'read-failed',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}
