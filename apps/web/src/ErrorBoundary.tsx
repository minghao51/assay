import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

/**
 * AR-W4: React error boundaries. Before this there was none anywhere, so any
 * render-path throw white-screened the whole workbench. Two boundaries are
 * wired: one at the composition root (main.tsx) and one around the data grid
 * (App.tsx), so a grid render failure leaves the rest of the workbench usable.
 *
 * The fallback is deliberately **static and value-free** (ADR 0025): it never
 * renders the thrown error, dataset values, file names, or cell contents —
 * only honest recovery copy (what to do and what state is lost). The error
 * itself is logged to the console for diagnosis; it is never swallowed.
 */

export type ErrorBoundaryScope = 'app' | 'grid'

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
    body: 'The rest of the workbench is still available. The opened file was not changed.',
    recovery: 'Reload the page to rebuild the grid. Any unsaved edits in this session are lost.',
  },
}

export interface ErrorBoundaryProps {
  readonly scope: ErrorBoundaryScope
  readonly children: ReactNode
}

interface ErrorBoundaryState {
  readonly failed: boolean
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { failed: false }
  }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Diagnosis only — never dataset contents (ADR 0025). The fallback UI
    // renders none of this.
    console.error(`[assay] ${this.props.scope} render error`, error, info.componentStack)
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children
    const copy = ERROR_BOUNDARY_COPY[this.props.scope]
    return (
      <section
        className={`error-boundary error-boundary-${this.props.scope}`}
        role="alert"
        data-testid={`error-boundary-${this.props.scope}`}
      >
        <h2>{copy.title}</h2>
        <p>{copy.body}</p>
        <p>{copy.recovery}</p>
        <button
          type="button"
          data-testid="error-boundary-reload"
          onClick={() => {
            window.location.reload()
          }}
        >
          Reload the workbench
        </button>
      </section>
    )
  }
}
