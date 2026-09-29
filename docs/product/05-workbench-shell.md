# Workbench Shell — Target Information Architecture (Ready State)

**Status:** spec (ux-5, 2026-09-29) — the shell direction it recommends is **Accepted** as
[D14: ADR 0044](../adr/0044-workbench-shell-two-pane.md) (2026-09-29);
**slice 1 (ux-6) landed 2026-09-29** (`267a45e`+`dc0b82a` → main `6a56175`/`c21e5a0`);
slice 2 is **PT-Q q-15** ([post-MVP track §7](04-post-mvp-track.md)). Driven by
[UX-3 of the interface audit](../reviews/2026-09-29-interface-ux-audit.md) (the IA buries the
workbench's centerpiece). Companion queue: [UX queue](../process/handoff/20260929-ux-queue.md).

---

## 1. Problem (audit evidence, updated 2026-09-29)

The ready state is a single 72rem column stacking eleven sections — schema → editing → export →
history → validation → compare → filters → grid → record → SQL → profile. At 1280×900 the page is
**2,271–2,385px tall**; the grid sits ~1,400px down, **below** six control panels; the
validation/compare panels that _drive_ the grid (jump, filter-to-failures) render above it, so a
validate→jump→edit round-trip is a long scroll each way. Only schema and profile collapse
(pre-ux-4); there are no anchors, no tabs, no way to see the grid and its driving panels
together. **Post ux-1…ux-4 mitigations** (grid horizontally scrollable, filter bar + diagnostics
collapsed by default, complete h2 map) improved the sections but not the IA: the grid is still
the least accessible element of a product positioned as a _workbench_.

## 2. Constraints and non-goals

- **Minimum supported viewport: desktop-first, 1024×700.** Below 1024px width the app serves the
  single-column collapsible stack (slice-1 shape) — **scroll, never clip** (the ux-1 discipline,
  pinned at 900px by `grid-horizontal.spec.ts`). No phone/narrow breakpoints are in scope
  (audit §4 non-goal; a workbench paradigm below ~1024px is questionable — this is the recorded
  decision, not an accident).
- **ADR 0022 (rendering replaceability):** the shell owns _layout_ only — panels and grid stay
  decoupled components; nothing in the shell may couple a panel to grid internals (no shared
  scroll containers beyond the grid's own, no grid-state reaching panel props).
- **f-2 memo boundaries:** the App decomposition (f-1: `App.tsx` 1,462→589 lines, session hooks)
  and its render-count pin must hold — shell changes are CSS/DOM-structure + section state, not
  data-flow changes.
- **A11y floor:** dual-scheme axe gates stay green with an empty allowlist; the ux-3 heading map
  (h1 + eleven h2s) is preserved verbatim in any layout; sticky nav is reachable by keyboard and
  does not trap focus.
- **Privacy (ADR 0025):** the shell adds no new copy beyond section names/counts already present.

## 3. Target IA — grid-centric two-pane shell (recommended; ADR 0044)

**Full shape (slice 2, post-ruling):**

```text
┌────────────────────────────────────────────────────────┐
│ header: app name · open status · info line             │
├──────────────┬─────────────────────────────────────────┤
│ tool pane    │ GRID (persistent center)                │
│ (collapsible │  sticky header, own scroll,             │
│  sections +  │  record inspector docked at the          │
│  sticky in-  │  bottom of the center column            │
│  pane nav)   │  (row-linked, not a pane peer)          │
│ schema       │                                         │
│ editing      │                                         │
│ export       │                                         │
│ history      │                                         │
│ validation ──┼─ jump / filter-to-failures act          │
│ compare    ──┼─ A-side jump acts                       │
│ filters      │                                         │
│ sql          │                                         │
│ profile      │                                         │
└──────────────┴─────────────────────────────────────────┘
```

- **Grid center, tools beside it.** The grid never unmounts or reorders when tools are used; the
  validation/compare controls that drive the grid sit beside it, making the
  validate→jump→edit round-trip a single screen.
- **Tool pane** (~320–360px, collapsible to a rail): one section expanded at a time by default,
  each section collapsible (uniform `<details>`-style pattern, `aria-expanded`, heading-wrapped
  per the ux-3 map), sticky in-pane nav. This subsumes the audit's "all panels collapsible" ask.
- **Record inspector** docks at the bottom of the center column (it is grid-linked state, not a
  co-equal tool): opens on row activation, closes on epoch shift — existing semantics unchanged.
- **Below 1024px** (and as the interim everywhere): the single-column stack of §1's order but
  with slice 1 applied.

**Slice 1 (committed as ux-6; not blocked on pane side/dock minutiae, only on the direction
ruling):** every top-level section collapsible with the uniform pattern; a sticky section nav
(above the stack; anchor/skip-link semantics); **the grid promoted above the panel stack** (right
after the open section) so the centerpiece is the first thing seen after open. Slice 1 is
single-column, DOM-order + CSS only, and is the <1024px shape regardless of the ruling.

## 4. Slice 1 acceptance list (ux-6's done-when contract)

1. Every top-level section (schema, editing, export, history, validation, compare, filters,
   grid, record, sql, profile) collapsible via one shared pattern; `aria-expanded`; the h2 map
   intact (headings wrap or precede toggles). **Slice-1 ruling (ux-6 review, 2026-09-29):** the
   h2s are owned by the child panels, so managed-section toggles precede their h2 and a collapsed
   section may drop its h2 from the a11y tree — uniform visible + aria-labeled toggles with the
   h2 map intact in the open state is the accepted slice-1 arrangement; heading-wrapped toggles
   across all sections are slice-2 (q-15) work.
2. Sticky section nav listing the sections in DOM order; keyboard-reachable; does not obscure
   the focused section (scroll-margin).
3. Grid renders immediately after the open section (above all other panels); grid first-paint
   unchanged (no new fetch/window behavior — rendering position only).
4. f-2 memo probe / render-count pin: unchanged or better.
5. Dual-scheme axe scans green, empty allowlist; heading-map component pin updated to the new
   order and still passing.
6. All journey e2e green (specs may gain open-section steps via shared helpers, assertions
   unchanged); the ux-1 900px scroll-never-clip pin green.

## 5. Sequencing and ownership

- **ux-6 (slice 1)** — **landed 2026-09-29** (`267a45e`+`dc0b82a` → main `6a56175`/`c21e5a0`,
  reviewer request-changes → fix → approve; the UX queue is closed). Implemented in
  `apps/web/src/App.tsx` + `index.css` per the UX queue row; `lib/bottom-panels.ts` untouched.
- **Slice 2 (two-pane split)** — PT-Q q-15
  ([post-MVP track §7](04-post-mvp-track.md)) behind the same ruling; separate task, own review
  cycle.
- The audit's UX-3 finding is remediated by slice 1 (landed 2026-09-29); the two-pane direction
  closes it fully at slice 2.

## 6. Open questions for the maintainer (folded into ruling D14)

1. Accept the two-pane direction (ADR 0044) — or stay single-column (slice 1 is then the whole
   remediation; q-15 is dropped)?
2. Pane side: tools left (reading order first) vs right (grid first in reading order)?
   Spec recommends **left** tools / right-priority grid (LTR reading puts the artifact first
   only if grid is left — counterargument recorded; ruling decides).
3. Record inspector dock (bottom of center) vs pane membership — spec recommends dock.
4. 1024px cutoff — confirm or amend (700px height is the other axis of the minimum).
