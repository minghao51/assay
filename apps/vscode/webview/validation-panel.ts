// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Validation presentation controller (D03b) — the desktop dataset webview's
 * validation panel: contract selection, one validation run, the report
 * rendering, its stale marker, and the correlated host frames.
 *
 * Extracted from the webview entry so the entry stays composition/wiring: the
 * controller receives explicit inputs (the message port, the current
 * edit-controller revision, an engine validate seam, a row-navigation seam)
 * and publishes nothing except DOM text/nodes and the posted request frames.
 * DOM-free decisions live in `src/pure/validation-presenter.ts`.
 *
 * Invariants (unchanged by the split):
 * - a FAILED or superseded run retains the previous report; the status line
 *   says so instead of clearing the panel,
 * - only the active generation may publish, cancel, or re-enable controls,
 * - a new contract resets the report (the old verdict is not this contract's),
 * - sample navigation resolves LOGICAL row keys, never positions.
 */
import type {
  EngineOverlay,
  EngineValidationPlan,
  EngineValidationResult,
} from '@assay/engine-duckdb'
import type { EngineColumnSchema } from '@assay/engine-duckdb'
import {
  isCurrentValidationGeneration,
  acceptsValidationFrame,
  parseAndCompileContract,
  projectValidation,
  VALIDATION_SAMPLE_LIMIT,
} from '../src/pure/validation-controller'
import type { ValidationProjection } from '../src/pure/validation-controller'
import {
  CANCELLED_STATUS,
  COMPILING_STATUS,
  NAVIGATION_FAILED_STATUS,
  ROW_NOT_IN_VIEW_STATUS,
  SELECT_CONTRACT_STATUS,
  describeCompileRefusal,
  describeContractFrame,
  describeValidationRule,
  describeValidationSample,
  describeValidationSummary,
  retainPreviousReport,
  validationStaleVisible,
} from '../src/pure/validation-presenter'
import { elementOrThrow } from './dom'

/** What the panel posts to the host (the validation half of the protocol). */
export interface ValidationHostRequest {
  readonly kind: 'validate-request'
  readonly id: string
  readonly generation: number
}

/** Explicit inputs of the validation panel. */
export interface ValidationPanelPorts {
  /** Post a request frame to the extension host. */
  readonly post: (message: ValidationHostRequest) => void
  /** The edit controller's current revision (for staleness). */
  readonly currentRevision: () => number
  /** Whether an edit operation is in flight (runs are refused while it is). */
  readonly editPending: () => boolean
  /** Effective columns of the view the run targets. */
  readonly effectiveColumns: () => readonly EngineColumnSchema[]
  /** Effective overlay of the view the run targets. */
  readonly overlay: () => EngineOverlay
  /** Engine seam: validate the effective view against a compiled plan. */
  readonly validate: (
    plan: EngineValidationPlan,
    overlay: EngineOverlay,
  ) => Promise<EngineValidationResult>
  /** Resolve a logical row key in the grid; `false` when it is not in view. */
  readonly navigateToRow: (rowKey: string) => Promise<boolean>
  /** New capability token id. */
  readonly createId: () => string
}

/**
 * The validation panel. One instance per opened dataset panel; `mount()` wires
 * the controls exactly once.
 */
export class ValidationPanel {
  private generation = 0
  private request: { readonly id: string; readonly generation: number } | null = null
  private contractText: string | null = null
  private report: ValidationProjection | null = null
  private busy = false
  private mounted = false

  constructor(private readonly ports: ValidationPanelPorts) {}

  /** The last PUBLISHED projection (retained across failed runs). */
  get publishedReport(): ValidationProjection | null {
    return this.report
  }

  /** The selected contract text, or `null` before a contract is chosen. */
  get selectedContract(): string | null {
    return this.contractText
  }

  /** The pending contract-selection request, if one is in flight. */
  get pendingRequest(): { readonly id: string; readonly generation: number } | null {
    return this.request
  }

  /** Wire the controls and reveal the panel (once). */
  mount(): void {
    if (this.mounted) return
    this.mounted = true
    elementOrThrow('contract-select').addEventListener('click', () => {
      this.requestContract()
    })
    elementOrThrow('validate-button').addEventListener('click', () => {
      void this.run()
    })
    elementOrThrow('validate-cancel').addEventListener('click', () => {
      this.cancel()
    })
    elementOrThrow('validation-controls').hidden = false
  }

  /** Ask the host for a local contract file (one request at a time). */
  requestContract(): void {
    if (this.request !== null) return
    const request = { id: this.ports.createId(), generation: ++this.generation }
    this.request = request
    this.ports.post({ kind: 'validate-request', ...request })
    this.status().textContent = SELECT_CONTRACT_STATUS
  }

  /**
   * Compile + validate the effective view. A failed compile, a failed engine
   * call, and a superseded generation all leave the previous report in place;
   * only an error-free current-generation result replaces it.
   */
  async run(): Promise<void> {
    if (this.busy || this.contractText === null || this.ports.editPending()) return
    this.busy = true
    const generation = ++this.generation
    const revision = this.ports.currentRevision()
    const status = this.status()
    status.textContent = COMPILING_STATUS
    elementOrThrow('validate-button').setAttribute('disabled', 'true')
    elementOrThrow('validate-cancel').hidden = false
    try {
      const compiled = parseAndCompileContract(this.contractText, this.ports.effectiveColumns())
      if (compiled.kind !== 'compiled') {
        const refusal = describeCompileRefusal(compiled.kind)
        if (isCurrentValidationGeneration(generation, this.generation)) status.textContent = refusal
        return
      }
      const overlay = this.ports.overlay()
      const result = await this.ports.validate(compiled.plan, overlay)
      if (!isCurrentValidationGeneration(generation, this.generation)) return
      const outcome = retainPreviousReport(this.report, {
        kind: 'published',
        report: projectValidation(result, revision, VALIDATION_SAMPLE_LIMIT),
      })
      this.publish(outcome.report)
      status.textContent = outcome.status
    } catch {
      if (isCurrentValidationGeneration(generation, this.generation)) {
        // The previous report stays published AS RENDERED: only the status
        // line changes. Re-rendering here would tear down the reader's
        // position for no new information.
        status.textContent = retainPreviousReport(this.report, { kind: 'retained' }).status
      }
    } finally {
      if (isCurrentValidationGeneration(generation, this.generation)) {
        this.busy = false
        elementOrThrow('validate-button').removeAttribute('disabled')
        elementOrThrow('validate-cancel').hidden = true
      }
    }
  }

  /** Cancel any in-flight run; late results are ignored by generation. */
  cancel(): void {
    this.generation++
    this.busy = false
    elementOrThrow('validate-button').removeAttribute('disabled')
    elementOrThrow('validate-cancel').hidden = true
    this.status().textContent = CANCELLED_STATUS
  }

  /** Recompute the stale marker against the current revision. */
  refreshStale(): void {
    elementOrThrow('validation-stale').hidden = !validationStaleVisible(
      this.report,
      this.ports.currentRevision(),
    )
  }

  /**
   * Handle a host frame. Returns `true` when the frame belonged to this panel
   * (so the entry stops routing it).
   */
  handleHostFrame(data: unknown): boolean {
    const frame = data as { kind?: unknown } | null
    if (frame === null || typeof frame !== 'object') return false
    if (
      frame.kind !== 'contract-loaded' &&
      frame.kind !== 'contract-cancelled' &&
      frame.kind !== 'contract-error'
    ) {
      return false
    }
    const expected = this.request
    if (expected === null) return true
    if (frame.kind === 'contract-loaded') {
      if (!acceptsValidationFrame(expected, data)) return true
      this.request = null
      this.contractText = data.text
      this.publish(null)
      elementOrThrow('validate-button').removeAttribute('disabled')
      this.status().textContent = describeContractFrame('loaded').status
      return true
    }
    const correlated =
      (frame as { id?: unknown }).id === expected.id &&
      (frame as { generation?: unknown }).generation === expected.generation
    if (!correlated) return true
    this.request = null
    this.status().textContent = describeContractFrame(
      frame.kind === 'contract-cancelled' ? 'cancelled' : 'error',
    ).status
    return true
  }

  /** Invalidate every pending request/run (panel close). */
  dispose(): void {
    this.generation++
    this.request = null
  }

  private publish(report: ValidationProjection | null): void {
    this.report = report
    const results = elementOrThrow('validation-results')
    results.replaceChildren()
    if (report === null) {
      elementOrThrow('validation-stale').hidden = true
      return
    }
    const summary = document.createElement('p')
    summary.textContent = describeValidationSummary(report)
    results.appendChild(summary)
    for (const rule of report.rules) {
      const section = document.createElement('section')
      const heading = document.createElement('p')
      heading.textContent = describeValidationRule(rule)
      section.appendChild(heading)
      for (const sample of rule.samples) {
        const button = document.createElement('button')
        button.type = 'button'
        button.textContent = describeValidationSample(sample)
        button.addEventListener('click', () => {
          void this.navigate(sample.rowKey)
        })
        section.appendChild(button)
      }
      results.appendChild(section)
    }
    this.refreshStale()
  }

  private async navigate(rowKey: string): Promise<void> {
    try {
      const found = await this.ports.navigateToRow(rowKey)
      if (!found) this.status().textContent = ROW_NOT_IN_VIEW_STATUS
    } catch {
      this.status().textContent = NAVIGATION_FAILED_STATUS
    }
  }

  private status(): HTMLElement {
    return elementOrThrow('validation-status')
  }
}
