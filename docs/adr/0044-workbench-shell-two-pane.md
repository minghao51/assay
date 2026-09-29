# ADR 0044: Grid-Centric Two-Pane Workbench Shell

## Status

Accepted (ruling D14, 2026-09-29 — accepted as written: two-pane direction, tools-left
pane, record-inspector dock, 1024×700 minimum viewport)

## Date

Proposed 2026-09-29 (ux-5); accepted same day by maintainer ruling **D14** —
[maintainer-rulings queue](../process/handoff/20260926-maintainer-rulings.md).

## Deciders

- Maintainer (ruling D14 pending)
- Spec authored by the UX queue (ux-5) from the 2026-09-29 interface audit

## Context

The web workbench's ready state stacks eleven sections in one 72rem column; the grid — the
product's centerpiece — sits ~1,400px down the page, below the validation/compare panels that
drive it, so every validate→jump→edit round-trip is a long scroll each way (audit finding
[UX-3](../reviews/2026-09-29-interface-ux-audit.md), `[MEASURED]`). The full evidence and the
slice plan live in the [workbench-shell spec](../product/05-workbench-shell.md).

Constraints that shape the decision: rendering stays replaceable per
[ADR 0022](0022-headless-grid-and-renderer-strategy.md) (the shell owns layout only, never grid internals);
the f-1 App decomposition and its render-count pins must hold; the accessibility floor
(dual-scheme axe, empty allowlist, complete heading map) is non-negotiable; phone viewports are
an explicit non-goal — the minimum supported viewport is desktop-first 1024×700, and below that
the app scrolls, never clips (UX-1 discipline).

## Decision

The ready state adopts a **grid-centric two-pane shell** at ≥1024px: the grid is the persistent
center; schema/editing/export/history/validation/compare/filters/SQL/profile live in a
collapsible tool pane beside it (record inspector docks at the bottom of the center column).
Below 1024px — and as the committed first slice (ux-6) everywhere until slice 2 lands — the app
serves a single-column stack with every section collapsible, a sticky section nav, and the grid
promoted above the panel stack.

## Consequences

### Positive

- The workbench's core artifact is always on screen; grid-driving panels act from beside it
  (audit UX-3 closed at slice 2, substantially remediated at slice 1).
- One shell decision settles section collapse, nav, and viewport policy for later surfaces
  (VS Code PT-V can mirror the pane split in a webview).
- Slice 1 is small, single-column, and unblocked-ish (rides f-1; no data-flow changes).

### Negative

- Two layouts to keep accessible and pinned (≥1024 two-pane; <1024 stack) — the a11y and
  journey suites must cover both.
- Pane collapse/expand state is new UI state to keep out of engine/data flow (component-local
  only).
- A second e2e viewport class (narrow) adds suite time; mitigated by keeping the narrow class
  to the existing 900px pin plus one journey smoke.

### Neutral

- If the maintainer rejects the two-pane direction, slice 1 stands alone as the UX-3 remediation
  and PT-Q q-15 (slice 2) is dropped; this ADR is then superseded by that ruling without
  renumbering.
