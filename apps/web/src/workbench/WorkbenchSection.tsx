// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ReactNode } from 'react'
import {
  WORKBENCH_SECTIONS,
  WORKBENCH_SECTION_PURPOSES,
  taskOfSection,
  type WorkbenchSectionId,
} from './tasks'

/**
 * D02a: one top-level workbench section shell, lifted out of `App.tsx`
 * verbatim. Purely presentational — it owns no state: App (still the
 * composition root) owns the open set, the focus moves and the disclosure
 * override, and passes them in. No hooks, no engine/session lifecycle, no
 * DOM/class/aria change.
 *
 * `App.tsx` keeps importing this module, so the section DOM contract the
 * shell tests pin (`section-<id>`, `section-toggle-<id>`, `section-purpose-<id>`,
 * `section-summary-<id>`, `data-task`) is unchanged.
 */

export interface WorkbenchSectionProps {
  readonly id: WorkbenchSectionId
  readonly children: ReactNode
  /**
   * `managed` (default): this shell owns the section's single disclosure
   * toggle. `inner`: the section's own component already exposes an equivalent
   * `aria-expanded` disclosure (Schema, Profile, Filters — the ux-3/ux-4
   * pattern this shell reuses), so the shell renders NO second toggle and just
   * wraps the content as the nav/scroll target.
   */
  readonly disclosure?: 'managed' | 'inner'
  /**
   * q-15: pane-controlled disclosure state. The tool pane owns the open set
   * (component-local shell state, never engine/data flow — ADR 0044) so a
   * sticky-nav activation can expand its target. Inner-disclosure sections
   * ignore this and stay open (their own control governs content).
   */
  readonly open: boolean
  readonly onToggle?: (id: WorkbenchSectionId) => void
  /**
   * ug-17: optional state summary for a shell-owned toggle (e.g.
   * `Validation · 2 failing`). The call site decides visibility — pass a
   * string only at count > 0 and `null`/nothing otherwise, so a zero count is
   * never rendered. It renders inside the toggle's text column, which keeps
   * it visible while the body is collapsed (the R-14 purpose precedent), and
   * becomes the toggle's SECOND description (after the purpose) without
   * touching the accessible name. Inner-disclosure sections ignore it: their
   * panels own their own collapsed summary (e.g. `Filters · N active`).
   */
  readonly summary?: string | null
}

/**
 * One top-level section shell. Collapse is CSS-only DOM structure + component
 * state: the body stays MOUNTED and gains the `hidden` attribute when
 * collapsed, so the grid's fetch/window/virtualization behavior and the f-2
 * memo boundaries are byte-identical (rendering position only, ADR 0022). The
 * stable `section-<id>` anchor is the sticky nav's scroll target;
 * `scroll-margin-top` (index.css) keeps it clear of the pinned nav.
 */
export function WorkbenchSection({
  id,
  children,
  disclosure = 'managed',
  open,
  onToggle,
  summary = null,
}: WorkbenchSectionProps) {
  const title = WORKBENCH_SECTIONS.find((section) => section.id === id)?.title ?? id
  const purpose = WORKBENCH_SECTION_PURPOSES[id]
  const contentId = `section-${id}-content`
  const purposeId = `section-${id}-purpose`
  const summaryId = `section-${id}-summary`
  // Only a shell-owned toggle can carry a summary; inner-disclosure panels
  // keep their own collapsed idiom (Filters) and get none from the shell.
  const summaryText = disclosure === 'managed' ? summary : null
  const toggleLabel = `${open ? 'Collapse' : 'Expand'} ${title}`
  const task = taskOfSection(id)
  return (
    <section
      className="workbench-section"
      id={`section-${id}`}
      data-section={id}
      data-task={task ?? undefined}
    >
      {disclosure === 'managed' && (
        <button
          type="button"
          className="workbench-section-toggle"
          data-testid={`section-toggle-${id}`}
          aria-expanded={open}
          aria-controls={contentId}
          /* ug-13/R-14: the purpose line is the toggle's DESCRIPTION, not its
             name — `Expand/Collapse <Title>` stays the accessible name the
             existing specs and pins query (the ug-4 hint pattern). */
          /* ug-17: the summary joins the description (purpose first, summary
             second) only while one exists; the name above is untouched. */
          aria-describedby={summaryText === null ? purposeId : `${purposeId} ${summaryId}`}
          aria-label={toggleLabel}
          title={toggleLabel}
          onClick={() => {
            onToggle?.(id)
          }}
        >
          <span className="workbench-section-marker" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
          <span className="workbench-section-text">
            <span className="workbench-section-label">{title}</span>
            <span
              className="workbench-section-purpose"
              id={purposeId}
              data-testid={`section-purpose-${id}`}
            >
              {purpose}
            </span>
            {summaryText !== null && (
              <span
                className="workbench-section-summary"
                id={summaryId}
                data-testid={`section-summary-${id}`}
              >
                {summaryText}
              </span>
            )}
          </span>
        </button>
      )}
      {/*
       * Inner-disclosure sections (Schema/Filters/Profile/Record) own their
       * own toggle, so the shell renders the same purpose line directly above
       * the body instead of inside a shell button. It stays visible while the
       * inner panel is collapsed (the bodies it describes are the panel's own)
       * and the nav link below points at this stable id.
       */}
      {disclosure === 'inner' && (
        <p
          className="workbench-section-purpose"
          id={purposeId}
          data-testid={`section-purpose-${id}`}
        >
          {purpose}
        </p>
      )}
      <div id={contentId} className="workbench-section-body" hidden={!open}>
        {children}
      </div>
    </section>
  )
}
