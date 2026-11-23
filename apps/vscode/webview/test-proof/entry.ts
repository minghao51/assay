// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * R-10 — the TEST-ONLY dataset webview entry (`dist/webview/dataset-proof.js`).
 *
 * This is the second webview entry, in the shape `dist/e2e-test.cjs` already
 * has for the extension host: a separate esbuild output that only the pinned
 * test host loads. `apps/vscode/src/dataset.ts` (`buildDatasetConfig`) points
 * the panel's `mainScriptUrl` at THIS bundle only when its test predicate
 * (`context.extensionMode === vscode.ExtensionMode.Test &&
 * process.env['ASSAY_E2E_EDIT_PROOF'] === '1'`) holds, and at the production
 * `dataset.js` otherwise.
 *
 * Why it exists: the production entry must not be able to reach the D03b
 * proof modules, so the composition moved here. This module imports the
 * production app (`../dataset`, whose module body boots the panel) and hands it
 * the proof runner through `installOpenProofs`. Dead-code elimination then
 * removes every `test-proof` module from `dataset.js`, because nothing in that
 * entry's import graph names them.
 *
 * The gate itself is unchanged and still has three independent layers: the
 * host computes the flag (above), the app passes `config.testHarness` straight
 * through, and `runOpenProofs` refuses unless it is exactly `true`
 * (`./index.ts`, pinned by `./index.test.ts`). The difference from before is
 * that production no longer carries the code at all — a structural gate
 * instead of an unreachable-but-shipped one.
 *
 * The runner adapter is typed against `OpenProofsRunner`, the shape declared by
 * the production entry, so a drift between the app's inputs and the proofs'
 * inputs is a typecheck failure here rather than a runtime mismatch.
 */
import { installOpenProofs, type OpenProofsRunner } from '../dataset'
import { runOpenProofs } from './index'

/** The app's declared seam type is the contract; the proof suite must fit it. */
const runner: OpenProofsRunner = async (input) => ({ ...(await runOpenProofs(input)) })

installOpenProofs(runner)
