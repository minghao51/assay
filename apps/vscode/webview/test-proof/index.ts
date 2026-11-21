// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Test-proof orchestration (D03b) — the single entry point the desktop
 * webview uses to run its `exercise*` acceptance suite.
 *
 * TEST-PROOF GATE (unchanged, and re-stated here so it cannot be dropped by a
 * refactor): the webview entry calls {@link runOpenProofs} only when its
 * injected config carries `testHarness: true`. The host computes that flag as
 * `context.extensionMode === vscode.ExtensionMode.Test &&
 * process.env['ASSAY_E2E_EDIT_PROOF'] === '1'` (`apps/vscode/src/dataset.ts`),
 * so a production open never runs any `exercise*` code, even though this module
 * stays in the production bundle — excluding it from bundling is a SEPARATE
 * measured decision, deliberately not taken here.
 *
 * The gate inside `runOpenProofs` is a second, independent check on the same
 * flag: the proof suite refuses to run unless `testHarness` is exactly `true`
 * (so a truthy non-boolean cannot open it either — pinned by the module test).
 */
import type { OverlayBase } from '@assay/domain'
import type { GridViewportModel } from '@assay/grid'
import type { EditController } from '../../src/pure/edit-controller'
import type { WebviewDataGrid } from '../data-grid'
import type { DiffPanel } from '../diff-panel'
import type { EngineGridProvider } from '../grid-provider'
import type { ValidationPanel } from '../validation-panel'
import { exerciseAcceptance } from './acceptance'
import type { AcceptanceProofResult } from './acceptance'
import { exerciseCommandDiff, exerciseStagedDiff } from './diff'
import type { CommandDiffProofResult, StagedDiffProofResult } from './diff'
import { exerciseRealEditor } from './editor'
import type { EditProofResult } from './editor'
import { exerciseEffectiveValidation } from './validation'
import type { ValidationProofResult } from './validation'

/** Proof payloads carried by the `opened` message (all optional). */
export interface OpenProofs {
  readonly editProof?: EditProofResult
  readonly validationProof?: ValidationProofResult
  readonly diffProof?: StagedDiffProofResult
  readonly diffCommandProof?: CommandDiffProofResult
  readonly acceptanceProof?: AcceptanceProofResult
}

/** Explicit inputs of the proof suite (everything it may touch). */
export interface OpenProofsInput {
  /** Gate flag copied from the injected webview config. */
  readonly testHarness: boolean
  /** Rows/columns of the opened dataset (the fixture gates read them). */
  readonly rows: number
  readonly columns: number
  readonly schema: readonly { readonly name: string; readonly type: string }[]
  /** True when the compare COMMAND opened this panel (reduced proof). */
  readonly commandOpened: boolean
  readonly grid: WebviewDataGrid
  readonly model: GridViewportModel
  readonly provider: EngineGridProvider
  readonly controller: EditController
  readonly base: OverlayBase
  readonly validation: ValidationPanel
  readonly diff: DiffPanel
  /** Export the effective copy as parquet (the CLI-agreement artifact). */
  readonly exportEffectiveCopy: () => Promise<void>
  /** Report the current proof stage for the host's failure categorisation. */
  readonly setStage: (stage: string) => void
}

/**
 * Run the proof suite. Returns `{}` (no proofs) for every non-test-mode open,
 * and on datasets that do not match a scenario's fixture shape — exactly the
 * gates the entry applied inline before the split.
 */
export async function runOpenProofs(input: OpenProofsInput): Promise<OpenProofs> {
  if (input.testHarness !== true) return {}
  const { rows, columns, schema, commandOpened, setStage } = input
  setStage('edit-proof')
  const editProof = await exerciseRealEditor({
    grid: input.grid,
    model: input.model,
    provider: input.provider,
    controller: input.controller,
    base: input.base,
    setStage,
  })
  setStage('validation-proof')
  const validationProof =
    rows === 5 && schema.some((column) => column.name === 'value_maybe_null')
      ? await exerciseEffectiveValidation({
          validation: input.validation,
          controller: input.controller,
          provider: input.provider,
          grid: input.grid,
          model: input.model,
          setStage,
        })
      : undefined
  const diffFullGate =
    !commandOpened &&
    rows === 12 &&
    columns === 2 &&
    schema[0]?.name === 'id' &&
    schema[1]?.name === 'value'
  const diffProof = diffFullGate
    ? await exerciseStagedDiff({
        diff: input.diff,
        controller: input.controller,
        provider: input.provider,
        grid: input.grid,
        exportEffectiveCopy: input.exportEffectiveCopy,
        setStage,
      })
    : undefined
  const diffCommandProof =
    commandOpened && rows === 12 && columns === 2
      ? await exerciseCommandDiff({
          diff: input.diff,
          controller: input.controller,
          provider: input.provider,
          grid: input.grid,
          setStage,
        })
      : undefined
  const acceptanceProof =
    !commandOpened &&
    rows === 12 &&
    columns === 3 &&
    schema[0]?.name === 'id' &&
    schema[1]?.name === 'value' &&
    schema[2]?.name === 'value_maybe_null'
      ? await exerciseAcceptance({
          validation: input.validation,
          diff: input.diff,
          controller: input.controller,
          provider: input.provider,
          grid: input.grid,
          exportEffectiveCopy: input.exportEffectiveCopy,
          setStage,
        })
      : undefined
  return {
    editProof,
    ...(validationProof === undefined ? {} : { validationProof }),
    ...(diffProof === undefined ? {} : { diffProof }),
    ...(diffCommandProof === undefined ? {} : { diffCommandProof }),
    ...(acceptanceProof === undefined ? {} : { acceptanceProof }),
  }
}
