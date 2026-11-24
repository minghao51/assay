---
'@assay/web': patch
---

feat(web): move Help beside Settings, tighten shell hierarchy, add the idle welcome block (WF-03, WFD-05 subparts 1–3).

The Workbench guide's single opener now shares the header's top-right cluster
with the Settings opener instead of sitting inline in the open-flow line. It
keeps `data-testid="help-open"`, `aria-haspopup="dialog"`, the
`helpBlocked || intent.kind !== 'none'` disabled guard and the existing
`openModal` arbitration unchanged, there is still exactly one opener in every
phase (no duplicate for any breakpoint), and focus returns to it on both close
paths. The open-flow control line is the Open control's line box alone
afterwards, and the ready-workspace top at 1024×700 was re-measured inside its
≤140px budget.

The idle screen's existing copy now has a hierarchy: one lead sentence, one
metadata line, a quieter engine/locality note group and the drop affordance,
styled with scoped classes and the existing space/type tokens. No heading, no
section order, no copy string and no new control changes — the heading map is
identical.

The idle-only welcome block composes the five existing `lib/app.ts` idle
constants and nothing else; it renders in `idle` and is absent in `opening`,
`ready` and `error`. Open, the CSV review entry, the example data action and
the drop affordance stay where they were and stay available after a failed
open. No new first-minute string is added (subpart 4 stays deferred), there is
no new keyboard trap, and the SQL outcome copy, the centre/pane layout and SQL
sizing are untouched.
