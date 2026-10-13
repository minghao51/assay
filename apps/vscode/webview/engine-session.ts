// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Engine ownership for the dataset webview (ptv1-4, carry-note from ptv1-3).
 *
 * The panel owns the engine — literally, now that the surface is a live
 * grid: ONE session per webview page (one custom-editor panel or one
 * command-opened panel), booted ONCE on first use and kept alive for every
 * later read (the grid fetches windows as the user scrolls, sorts, and
 * filters — the pre-ptv1-4 open-then-dispose flow would have broken every
 * fetch after the first). `dispose()` is idempotent and runs when:
 *   - the host orchestrates the close (the command path posts `dispose`
 *     before `panel.dispose()`), or
 *   - the panel closes on the custom-editor path: VS Code tears the webview
 *     page down, which terminates the engine worker and frees the WASM heap
 *     with it (the page cannot outlive its panel), and the blob URLs are
 *     revoked in `VendoredEngineBoot.dispose` either way.
 */
import { bootVendoredEngine } from './engine-boot'
import type { EngineBootSpec, VendoredEngineBoot, WorkerDiagnostic } from './engine-boot'

export class EngineSession {
  private bootPromise: Promise<VendoredEngineBoot> | null = null

  /**
   * Boot the vendored engine once per session and return the same boot to
   * every caller. A boot failure is memoized like a success: a wedged boot
   * fails every later acquire with the same error (retry = new panel).
   */
  async acquire(
    spec: EngineBootSpec,
    diagnostics: Array<WorkerDiagnostic> = [],
  ): Promise<VendoredEngineBoot> {
    this.bootPromise ??= bootVendoredEngine(spec, diagnostics)
    return this.bootPromise
  }

  /** Tear the engine down (idempotent; awaits an in-flight boot first). */
  async dispose(): Promise<void> {
    const boot = this.bootPromise
    this.bootPromise = null
    if (boot === null) return
    try {
      const live = await boot
      await live.dispose()
    } catch {
      // A failed boot has nothing to tear down (bootVendoredEngine already
      // cleaned up); disposal stays best-effort by contract.
    }
  }
}
