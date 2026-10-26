// SPDX-License-Identifier: AGPL-3.0-or-later

import { Component, Fragment, createRef } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

/**
 * AR-W4: React error boundaries. Before this there was none anywhere, so any
 * render-path throw white-screened the whole workbench. Three scopes are
 * wired: the composition root (main.tsx, `app`), the data grid (App.tsx,
 * `grid`), and every tool-pane section body (App.tsx, `panel`, ug-7/R-06).
 * A panel render failure is contained to that section; a grid failure leaves
 * the rest of the workbench usable; only an app-scope failure replaces the
 * whole page.
 *
 * The fallback is deliberately **static and value-free** (ADR 0025): it never
 * renders the thrown error, dataset values, file names, or cell contents —
 * only honest recovery copy (what to do and what state is lost). The error
 * itself is logged to the console for diagnosis; it is never swallowed.
 *
 * Recovery (ug-7): `Try again` clears only THIS boundary's failed state and
 * remounts its child via a keyed Fragment. It never reloads, calls
 * `beginSession()`, or touches the opened dataset / committed staged
 * history. A deterministic fault simply throws again and stays contained.
 * The panel `Close section` action is owned by App (the section shell owns
 * visibility); a hidden body stays mounted, so reopening the section shows
 * the retained fallback until the user explicitly retries.
 */

export type ErrorBoundaryScope = 'app' | 'grid' | 'panel'

interface BoundaryCopy {
  readonly title: string
  readonly body: string
  readonly recovery: string
}

/**
 * Static fallback copy per boundary. Exported so the no-dynamic-values pin can
 * assert the rendered text equals it exactly (nothing interpolated).
 */
export const ERROR_BOUNDARY_COPY: Readonly<Record<ErrorBoundaryScope, BoundaryCopy>> = {
  app: {
    title: 'Assay hit an unexpected error',
    body: 'The workbench could not render. Nothing was sent anywhere and the opened file was not changed.',
    recovery:
      'Reload the page to start a fresh session. Any unsaved edits in this session are lost.',
  },
  grid: {
    title: 'The data grid could not render',
    body: 'The rest of the workbench and committed staged changes remain available. The opened file was not changed.',
    recovery:
      'Try again resets the grid view; an uncommitted cell draft, focus and scroll position may be lost. Reload starts a fresh session and loses session edits.',
  },
  panel: {
    title: 'This section could not render',
    body: 'The grid and staged changes remain available. The opened file was not changed.',
    recovery:
      "Try again resets this section's local state. If the error returns, close the section and use another tool.",
  },
}

export interface ErrorBoundaryProps {
  readonly scope: ErrorBoundaryScope
  readonly children: ReactNode
  /**
   * Panel scope only: close the failed section through App's existing shell
   * visibility state. The boundary itself never owns section visibility.
   */
  readonly onClose?: () => void
  /**
   * Section id used to place focus after a successful retry (the section's
   * `section-<id>-content` body and its existing nav link). App passes the
   * shell id for panel and grid scopes; app scope has no section target.
   */
  readonly sectionId?: string
}

interface ErrorBoundaryState {
  readonly failed: boolean
  /** Bumped on every retry so the (previously unmounted) child remounts. */
  readonly resetSeq: number
}

/** First focusable control inside a recovered section body. */
const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

/** Fallback focus is only meaningful when the section body is visible. */
function isReachable(element: HTMLElement): boolean {
  return element.closest('[hidden]') === null
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  private readonly fallbackRef = createRef<HTMLElement>()

  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { failed: false, resetSeq: 0 }
  }

  static getDerivedStateFromError(): Pick<ErrorBoundaryState, 'failed'> {
    return { failed: true }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Diagnosis only — never dataset contents (ADR 0025). The fallback UI
    // renders none of this. This boundary is the app's final diagnostic sink;
    // its fallback UI stays value-free.
    // eslint-disable-next-line no-console -- targeted allowlist for the single final diagnostic sink (ADR 0025).
    console.error(`[assay] ${this.props.scope} render error`, error, info.componentStack)
    // Focus reachable fallback content on failure (R-06/R-07). A collapsed
    // section keeps its fallback mounted but not reachable; the nav link that
    // reopens it is the focus target in that case, not a hidden button. App
    // scope keeps its pre-ug-7 behavior (the whole page is replaced).
    if (this.props.scope === 'app') return
    const fallback = this.fallbackRef.current
    if (fallback !== null && isReachable(fallback)) fallback.focus()
  }

  override componentDidUpdate(
    _previousProps: Readonly<ErrorBoundaryProps>,
    previousState: Readonly<ErrorBoundaryState>,
  ): void {
    if (previousState.failed && !this.state.failed) this.focusAfterRetry()
  }

  /**
   * After a successful retry, move focus to a usable target in the recovered
   * section (its first control) rather than leaving it on the removed retry
   * button. If the section rendered without a control, fall back to its
   * existing nav link.
   */
  private focusAfterRetry(): void {
    const { sectionId } = this.props
    if (sectionId === undefined) return
    const content = document.getElementById(`section-${sectionId}-content`)
    if (content !== null && isReachable(content)) {
      const focusable = content.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
      if (focusable !== null) {
        focusable.focus()
        return
      }
    }
    document.querySelector<HTMLElement>(`[data-testid="section-nav-${sectionId}"]`)?.focus()
  }

  private retry(): void {
    this.setState((previous) => ({ failed: false, resetSeq: previous.resetSeq + 1 }))
  }

  override render(): ReactNode {
    if (!this.state.failed) {
      // Keying the Fragment remounts the boundary's child on retry, which is
      // the only reset the toolbar promises: section-local state, never the
      // dataset session or committed staged history.
      return <Fragment key={this.state.resetSeq}>{this.props.children}</Fragment>
    }
    const { scope, onClose } = this.props
    const copy = ERROR_BOUNDARY_COPY[scope]
    return (
      <section
        ref={this.fallbackRef}
        className={`error-boundary error-boundary-${scope}`}
        role="alert"
        tabIndex={-1}
        data-testid={`error-boundary-${scope}`}
        data-section={this.props.sectionId}
      >
        <h2>{copy.title}</h2>
        <p>{copy.body}</p>
        <p>{copy.recovery}</p>
        <div className="error-boundary-actions">
          {scope !== 'app' && (
            <button
              type="button"
              className="error-boundary-retry"
              data-testid="error-boundary-retry"
              onClick={() => {
                this.retry()
              }}
            >
              Try again
            </button>
          )}
          {scope === 'panel' && onClose !== undefined && (
            <button
              type="button"
              className="error-boundary-close"
              data-testid="error-boundary-close"
              onClick={onClose}
            >
              Close section
            </button>
          )}
          {scope !== 'panel' && (
            <button
              type="button"
              className="error-boundary-reload"
              data-testid="error-boundary-reload"
              onClick={() => {
                window.location.reload()
              }}
            >
              Reload the workbench
            </button>
          )}
        </div>
      </section>
    )
  }
}
