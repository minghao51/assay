// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyHistory } from '@assay/domain'
import type { OverlayBase } from '@assay/domain'
import type { GridViewportModel } from '@assay/grid'
import { usePipelineSession } from '../pipeline/usePipelineSession'
import type { PipelineSession } from '../pipeline/usePipelineSession'
import { useValidationSession } from '../sessions/useValidationSession'
import type { ValidationSession } from '../sessions/useValidationSession'
import type { DatasetSession } from '../sessions/session-reset'
import type { Phase } from '../sessions/types'
import { MAX_CONTRACT_BYTES } from './contract-import'

/**
 * D01 — CALLER-Level pins for the contract import.
 *
 * `contract-import.test.ts` pins the boundary unit by unit: the size bound is
 * checked from metadata before any byte is read, a read returns the decoded
 * text, a read failure degrades to a typed outcome. What that file cannot pin
 * is what the two callers DO with the `'read'` text, which is the other half
 * of D01's acceptance:
 *
 * 1. invalid YAML is a SUCCESSFUL read followed by the downstream typed parse
 *    refusal — the caller parses the read text and publishes `parse-error`
 *    (with the parser's line/column), never a `read-failed`;
 * 2. a late read cannot publish after the dataset session token moved — both
 *    callers capture the token before the read awaits and drop the result
 *    (including the parse call) when a re-open happened meanwhile;
 * 3. BOTH callers hand the READ text to `parseContract` exactly once
 *    (`useValidationSession` for the panel, `usePipelineSession` for a
 *    `validate` node) — the split the rename is about.
 *
 * The parser itself is NOT faked: the spy records the argument and delegates
 * to the real total parser, so a wrong text, a skipped call or a fabricated
 * verdict all fail here. The only other faked boundary is the OS picker
 * (`pickDataFile`), which returns queued `File`s like the App-level suites.
 */

const h = vi.hoisted(() => ({
  /** The picker queue for the pipeline caller (one `File` per pick). */
  pickerQueue: [] as File[],
  /** Every text an app caller handed to `parseContract` (in order). */
  parseTexts: [] as string[],
}))

vi.mock('@assay/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@assay/contracts')>()
  return {
    ...actual,
    // Record the CALL argument, then run the real parser: the verdict (and
    // the located errors) are genuinely computed from the read text.
    parseContract: (text: string) => {
      h.parseTexts.push(text)
      return actual.parseContract(text)
    },
  }
})

vi.mock('@assay/data-sources/browser', () => ({
  pickDataFile: async (): Promise<{
    readonly via: string
    readonly source: { getFile: () => Promise<File> }
  } | null> => {
    const file = h.pickerQueue.shift()
    if (file === undefined) throw new Error('the test picker queue was exhausted')
    return { via: 'input-fallback', source: { getFile: async () => file } }
  },
}))

/** Malformed YAML (`columns` is not a list): a READ that the parser refuses. */
const BAD_CONTRACT_YAML = `format: v1
name: d01-broken
version: 1
columns: not-a-list
`

/** The same shape, valid: proves the caller's parse verdict is not fixed. */
const GOOD_CONTRACT_YAML = `format: v1
name: d01-gate
version: 1
columns:
  - name: customer_id
    type: BIGINT
dataset:
  min-rows: 1
`

/** The gate pipeline (source → filter → validate → publish) for the binder. */
const GATED_PIPELINE_YAML = `version: 1
pipeline: d01_gate_pin
nodes:
  customers:
    type: source
    source:
      kind: file
      path: ../csv/customers.csv
  gate:
    type: validate
    input: sg
    contract: contracts/strict.yaml
  out:
    type: publish
    input: sg
    requires: [ gate ]
  sg:
    type: transform
    inputs: [ customers ]
    operation:
      filter:
        predicates:
          - column: country
            operator: equals
            value: SG
`

/**
 * The structural slice `readContractFile` consumes (`size` + `text()`), cast
 * to `File` for the hook signatures. A deferred `text()` is how a read is
 * held in flight across a session re-open.
 */
function contractFile(size: number, text: () => Promise<string>): File {
  return { size, text } as unknown as File
}

function deferredText(): {
  readonly file: (size: number) => File
  readonly resolve: (text: string) => void
  /** How many times the read was actually started (`text()` called). */
  readonly readStarted: () => number
} {
  let resolve!: (text: string) => void
  let starts = 0
  const promise = new Promise<string>((res) => {
    resolve = res
  })
  return {
    file: (size: number) =>
      contractFile(size, () => {
        starts += 1
        return promise
      }),
    resolve,
    readStarted: () => starts,
  }
}

/** A live dataset session (a real token ref; a no-op reset registry). */
function sessionWithToken(token: number): DatasetSession {
  return {
    tokenRef: { current: token },
    beginSession: () => token,
    registerReset: () => () => {},
  }
}

const BASE: OverlayBase = {
  baseAnchor: 'fv-2-1000',
  overlayAnchor: 'ov-1',
  columns: [{ name: 'customer_id', type: 'BIGINT' }],
  baseRowCount: 2,
}

const PHASE: Phase = {
  kind: 'ready',
  model: {} as unknown as GridViewportModel,
  tableId: 't1',
  handle: { kind: 'table', id: 't1' },
  base: BASE,
  provider: {} as never,
}

beforeEach(() => {
  h.pickerQueue = []
  h.parseTexts = []
})

describe('D01 — validation caller (useValidationSession)', () => {
  function mountValidation(session: DatasetSession): { readonly current: ValidationSession } {
    // The hook result object (not a snapshot) so every read sees current state.
    const hook = renderHook(() =>
      useValidationSession({
        phase: PHASE,
        session,
        historyRef: { current: emptyHistory() },
        overlayRef: { current: null },
        overlayRevision: 0,
        sourceIdentityRef: { current: null },
        navigateToRow: () => {},
      }),
    )
    return hook.result
  }

  it('reads invalid YAML, then publishes the parser’s located refusal (not a read failure)', async () => {
    const result = mountValidation(sessionWithToken(1))

    // Drive the REAL panel seam: the pick reads text, the session parses it.
    await act(async () => {
      result.current.handleContractFile(
        contractFile(BAD_CONTRACT_YAML.length, async () => BAD_CONTRACT_YAML),
      )
    })

    await waitFor(() => {
      expect(result.current.contractState.kind).toBe('parse-error')
    })
    const state = result.current.contractState
    if (state.kind !== 'parse-error') throw new Error('expected a published parse refusal')
    // The refusal is the PARSER's: located, typed errors — proof the read
    // succeeded and the text reached the total parser.
    expect(state.errors.length).toBeGreaterThan(0)
    expect(state.errors[0]).toMatchObject({ line: expect.any(Number), column: expect.any(Number) })
    // ...and the caller parsed exactly the text the read produced, once.
    expect(h.parseTexts).toEqual([BAD_CONTRACT_YAML])
  })

  it('publishes a loaded contract when the read text DOES parse (positive control)', async () => {
    const result = mountValidation(sessionWithToken(1))

    await act(async () => {
      result.current.handleContractFile(
        contractFile(GOOD_CONTRACT_YAML.length, async () => GOOD_CONTRACT_YAML),
      )
    })

    await waitFor(() => {
      expect(result.current.contractState.kind).toBe('loaded')
    })
    const state = result.current.contractState
    if (state.kind !== 'loaded') throw new Error('expected a loaded contract')
    expect(state.contract.metadata.name).toBe('d01-gate')
    expect(h.parseTexts).toEqual([GOOD_CONTRACT_YAML])
  })

  it('cannot publish a late read once the session token moved (no parse either)', async () => {
    const session = sessionWithToken(1)
    const result = mountValidation(session)
    const late = deferredText()

    // The read is in flight when the dataset is re-opened (beginSession bumps
    // the token before the reset runs — reproduced here by the direct bump).
    act(() => {
      result.current.handleContractFile(late.file(GOOD_CONTRACT_YAML.length))
    })
    // The guard under test is the one AFTER the read: prove the read started
    // under the old token, so a pass cannot come from an earlier return.
    expect(late.readStarted()).toBe(1)
    session.tokenRef.current = 2
    await act(async () => {
      late.resolve(GOOD_CONTRACT_YAML)
    })

    // Nothing attached, and the stale text was never handed to the parser.
    expect(result.current.contractState).toEqual({ kind: 'none' })
    expect(h.parseTexts).toEqual([])
  })

  it('publishes a failed read and an over-bound pick without parsing either', async () => {
    const result = mountValidation(sessionWithToken(1))

    await act(async () => {
      result.current.handleContractFile(
        contractFile(10, async () => {
          throw new Error('the handle was revoked')
        }),
      )
    })
    await waitFor(() => {
      expect(result.current.contractState).toEqual({
        kind: 'read-failed',
        message: 'the handle was revoked',
      })
    })

    await act(async () => {
      result.current.handleContractFile(
        contractFile(MAX_CONTRACT_BYTES + 1, async () => GOOD_CONTRACT_YAML),
      )
    })
    await waitFor(() => {
      expect(result.current.contractState).toEqual({ kind: 'too-large' })
    })

    // Neither outcome is a read of text, so neither reaches the parser.
    expect(h.parseTexts).toEqual([])
  })
})

describe('D01 — pipeline caller (usePipelineSession)', () => {
  async function mountOpenPipeline(
    session: DatasetSession,
  ): Promise<{ readonly current: PipelineSession }> {
    // The hook result object (not a snapshot) so every read sees current state.
    const hook = renderHook(() =>
      usePipelineSession({
        session,
        sourceIdentityRef: { current: null },
        openSourceRef: { current: null },
        loadedContract: null,
      }),
    )
    h.pickerQueue.push(new File([GATED_PIPELINE_YAML], 'gate-pin.yaml'))
    await act(async () => {
      hook.result.current.openPipelineFile()
    })
    expect(hook.result.current.fileState.kind).toBe('loaded')
    return hook.result
  }

  it('binds a validate node from invalid YAML as a located parse refusal, not a read failure', async () => {
    const result = await mountOpenPipeline(sessionWithToken(1))

    h.pickerQueue.push(new File([BAD_CONTRACT_YAML], 'broken-contract.yaml'))
    await act(async () => {
      result.current.bindContract('gate')
    })

    await waitFor(() => {
      expect(result.current.contractBindings['gate']?.kind).toBe('parse-error')
    })
    const binding = result.current.contractBindings['gate']
    if (binding?.kind !== 'parse-error') throw new Error('expected a located parse refusal')
    expect(binding.errors.length).toBeGreaterThan(0)
    expect(binding.errors[0]).toMatchObject({
      line: expect.any(Number),
      column: expect.any(Number),
    })
    // The READ text (not the file name, not a re-serialization) is what the
    // binder parsed.
    expect(h.parseTexts).toEqual([BAD_CONTRACT_YAML])
  })

  it('cannot bind a late read once the session token moved (no parse either)', async () => {
    const session = sessionWithToken(1)
    const result = await mountOpenPipeline(session)
    const late = deferredText()

    h.pickerQueue.push(late.file(GOOD_CONTRACT_YAML.length))
    // The pick and `getFile()` settle under the OLD token, so the hook parks
    // at the read itself — the guard this test pins is the one after it.
    await act(async () => {
      result.current.bindContract('gate')
    })
    expect(late.readStarted()).toBe(1)
    session.tokenRef.current = 2
    await act(async () => {
      late.resolve(GOOD_CONTRACT_YAML)
    })

    // The node stays honestly unbound (no `bound`, no `parse-error`, no stale
    // `read-failed`), and the discarded text was never parsed.
    expect(result.current.contractBindings['gate']).toBeUndefined()
    expect(h.parseTexts).toEqual([])
  })
})
