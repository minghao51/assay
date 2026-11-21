// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * D03b — the test-proof gate.
 *
 * The webview entry calls `runOpenProofs` for every open; the gate inside it
 * (`testHarness !== true` ⇒ `{}`) is the second, independent check on the same
 * flag the host sets only under `vscode.ExtensionMode.Test`
 * (`apps/vscode/src/dataset.ts`). These tests pin that a production open never
 * reaches ANY `exercise*` code path, and that a test-mode open does.
 *
 * Note the deliberate scope: this proves the GATE, not the proofs. Excluding
 * this module from the production bundle is a separate measured decision and
 * is not taken here.
 */
import { describe, expect, it } from 'vitest'
import { runOpenProofs } from './index'
import type { OpenProofsInput } from './index'

/** An input whose every non-gate read is a test failure. */
function proofInput(testHarness: boolean): OpenProofsInput {
  const trap = {
    get(_target: unknown, property: string | symbol): unknown {
      if (property === 'testHarness') return testHarness
      throw new Error(`proof input was read before the gate: ${String(property)}`)
    },
  }
  return new Proxy({ testHarness }, trap) as unknown as OpenProofsInput
}

describe('test-proof gate', () => {
  it('runs no proof for a production (non-test-mode) open', async () => {
    const proofs = await runOpenProofs(proofInput(false))
    expect(proofs).toEqual({})
  })

  it('refuses a non-boolean gate flag (only `true` opens the gate)', async () => {
    const falsy = { testHarness: 'yes' } as unknown as OpenProofsInput
    expect(await runOpenProofs(falsy)).toEqual({})
    const missing = {} as unknown as OpenProofsInput
    expect(await runOpenProofs(missing)).toEqual({})
  })

  it('does read its inputs once the gate is open (test mode)', async () => {
    await expect(runOpenProofs(proofInput(true))).rejects.toThrow(
      'proof input was read before the gate',
    )
  })
})
