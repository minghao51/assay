# Interface & Usability Audit — 2026-09-29

> **Point-in-time record, pinned at `main` = `c916974`.** Findings with `UX-*` IDs are picked up
> by the **UX queue** ([`../process/handoff/20260929-ux-queue.md`](../process/handoff/20260929-ux-queue.md)).
> Read as history once the queue closes; current state: [`../process/handoff.md`](../process/handoff.md).

**Scope:** the web workbench's operational interface — every user-facing surface of `apps/web`
(open flow, schema panel, edit toolbar, export dialog, history, validation, comparison, filters,
grid, record inspector, SQL pane, profile pane) plus a read of the CLI's help surface. Not in
scope: engine internals, package layering, CI (all freshly audited by AU-2/AU-3, 2026-09-27/28).

**Method:** built the app (`pnpm build` green, 9 tasks) and drove it through the real picker path
in Chromium 1280×900 — flat/nested/wide fixtures, validation with a contract through the verdict
and jump/filter controls, a staged comparison through key confirmation, a profile run, the export
dialog, the record inspector, and cell editing — capturing DOM outlines, section text, geometry,
and keyboard/focus behavior at each step. A synthetic 15-column CSV isolated wide-dataset
behavior. Code-level reading of `App.tsx`, all panels, `DataGrid.tsx`, and `index.css` mapped the
observed behavior to causes. Existing e2e/axe gates (dual-scheme, empty allowlist) were not
re-run; they were treated as passing context, which is why this audit focused on usability,
clarity, and intuitiveness **beyond** WCAG compliance.

**Verification labels:** `[REPRO]` = reproduced/verified by driving the live app with measured
evidence; `[MEASURED]` = numeric evidence captured from the live DOM; `[READ]` = code-reading
finding, not probed live.

**Baseline inherited** from the AU-2 close (2026-09-28): unit 1967 / e2e 145+1 / lint 0-0 /
coverage 88.04/81.82/85.59/89.28 / 111 changesets; this audit changed no source.

---

## 1. P1 — Critical usability defect

### UX-1 — The grid cannot scroll horizontally; wide datasets are unusable `[REPRO]` `[MEASURED]`

`DataGrid.tsx` sizes columns as `repeat(N, minmax(9rem, 1fr))` (apps/web/src/grid/DataGrid.tsx:416-419)
while `.grid-viewport` pins `overflow-x: hidden` (`apps/web/src/index.css`, grid-viewport block).
With a 15-column CSV at 1280×900: last column's right edge **x=2192** vs viewport client width
**1150** (`scrollWidth 2240`); the header row shares the template, so header and cells clip
identically — columns ~8–15 are rendered, clipped, and **unreachable by any interaction**
(no horizontal scroll, no column virtualization, no way to reach them from the keyboard either —
focus follows rows, and cells outside the clipped box cannot be scrolled into view). The committed
fixtures top out at 5 columns, which is why no existing spec catches this. Real CSV/Parquet
routinely has 20–100+ columns; for those datasets the grid — the workbench's centerpiece — is
unusable. (Values remain reachable through the schema panel / record inspector, which is not a
grid substitute.)

## 2. P2 — Major findings

### UX-2 — Raw internal state rendered as user copy `[REPRO]`

- The open-status span renders `phase.kind` literally: **"idle" / "opening" / "ready"**
  (apps/web/src/App.tsx, `<span data-testid="open-status">{phase.kind}</span>`). Lowercase dev
  tokens in the first thing the user reads.
- The headline info line exposes the engine handle: **"table t1 · 5 rows · 4 columns"**; the SQL
  hint repeats **"assay_t1"**. The filename-privacy rule (ADR 0025) rightly forbids the file name —
  but the copy can be human ("Dataset · 5 rows · 4 columns") while `t1`/`assay_t1` stay only where
  SQL actually needs them (SQL pane hint), not in the status line.

### UX-3 — Information architecture buries the workbench's centerpiece `[MEASURED]`

The ready page is a single 72rem column, **2,271–2,385px tall** at 1280×900, stacking eleven
sections: schema → edit toolbar → export → history → validation → compare → filters → **grid** →
record → SQL → profile. The grid sits ~1,400px down the page, below six control panels; the
validation/compare panels that _drive_ the grid (jump, filter-to-failures) render above it, so a
validate→jump→edit round-trip is a long scroll each way. Only schema and profile collapse; there
are no anchors, no tabs, no way to get the grid and its driving panels on screen together. For a
product positioned as a _workbench_, the core artifact is the least accessible element of the
shell.

### UX-4 — Filtering is SQL-fragment-only `[READ]`

The per-column filter inputs accept engine-SQL predicate fragments (`> 50000`, `= 'US'`) — a good
power feature, honestly hinted, but unusable for non-SQL users: no operator/value builder, the
placeholder (`e.g. > 50000`) is identical for every column type including dates, and an invalid
fragment is only discovered on the engine round-trip. See also UX-8 for the layout cost.

## 3. P3 — Minor findings (polish)

### UX-5 — Profile/diff stats display raw float noise `[REPRO]`

"Stddev **1.6329931618554474**", "p99 **955.0500000000002**" (profile panel);
"variance shift 1.68, p90 shift 2" vs "mean shift 0.505964" (diff deltas). `format-stats`
carries full double precision into display copy. Display-only fix (sig-fig rounding); the JSON
export envelopes must stay byte-stable (M6 agreement discipline).

### UX-6 — Duplicate Undo/Redo control pairs `[READ]`

`EditToolbar` and `HistoryPanel` each render Undo/Redo, adjacent on the page. One pair should
remain (the history panel owns the time-travel mental model; the toolbar keeps insert + pending
summary).

### UX-7 — Sparse heading map `[READ]`

h1 "Assay"; h2 only inside Validation ("Validation") and Compare ("Compare"). Schema, Editing,
Export, History, Filters, SQL, and Profile sections carry no headings at all (their toggles are
bare buttons). Screen-reader heading navigation gets a two-node map of an eleven-section page.

### UX-8 — Filter bar scales poorly with column count `[MEASURED]`

One label+input+Apply triplet per column, always all rendered: 15 columns → fifteen inputs
wrapping across ~5 rows of always-visible UI before the grid. Collapsed-by-default with an
active-count summary is the standard remedy (the builder in UX-4 subsumes this).

### UX-9 — Engineering telemetry in the grid footer `[READ]`

"fetches=1 requested=5 received=5 maxSpan=5 cached=5" renders to end users. Honest, but
diagnostics-class; belongs behind a details disclosure or diagnostics toggle.

### UX-10 — No announcement or focus move when a file opens `[READ]`

After a successful open, the page grows ~2,000px of content while focus stays on the Open button;
`open-status` text changes with no `aria-live`. The single polite live region covers edit outcomes
only. Keyboard/SR users get no signal that the app's entire state changed.

## 4. Explicit non-goals (recorded, not queued)

- **Phone/narrow-viewport support.** At 900px the layout merely wraps; a workbench paradigm below
  ~1024px is questionable. The shell spec (queue ux-5) should declare a minimum supported
  viewport instead of building responsive breakpoints. UX-1 must still not _clip_ at narrow
  widths (scroll, never clip).

## 5. What held up well (worth recording)

- **Honesty-first copy is consistent and exceptional** — "Nothing is uploaded", "The opened file
  is not changed", stale banners, clamp notes, "Inference is a proposal, never a key". Every
  panel explains what it does and does not claim.
- **Accessibility is engineered, not sprinkled** — role=grid with row/col counts, roving-tabindex
  keyboard nav (verified live: Tab lands on Open first; Enter opens the cell editor), disclosure
  patterns with `aria-expanded`, one polite live region, `role="alert"` errors, dual-scheme axe
  gates with a non-vacuity canary.
- **Privacy discipline holds under probing** — no filename rendered anywhere in the driven flows.
- **The editing model is coherent** — overlay + time-travel history cursor + dirty markers + typed
  rejections reads as one trustworthy mental model.
- **Empty states and error recovery** — every panel has an instructive zero state; the filter bar
  restores the previous accepted state on rejection; the view-error retry affordance is honest.
- **The CLI surface is clean** — concise help, documented exit codes, quiet/piped-aware output.

## 6. Findings → ownership map

| Finding                           | Severity | Queue task                   |
| --------------------------------- | -------- | ---------------------------- |
| UX-1 grid horizontal reachability | P1       | ux-1                         |
| UX-2 raw internal state in copy   | P2       | ux-2                         |
| UX-10 no open announcement        | P2       | ux-2                         |
| UX-3 IA buries the grid           | P2       | ux-5 (spec) → ux-6 (slice 1) |
| UX-4 SQL-only filtering           | P2       | ux-4                         |
| UX-8 filter bar scaling           | P3       | ux-4 (subsumed)              |
| UX-5 float noise                  | P3       | ux-3                         |
| UX-6 duplicate undo/redo          | P3       | ux-3                         |
| UX-7 heading map                  | P3       | ux-3                         |
| UX-9 diagnostics footer           | P3       | ux-3                         |

Queue: [`../process/handoff/20260929-ux-queue.md`](../process/handoff/20260929-ux-queue.md).
