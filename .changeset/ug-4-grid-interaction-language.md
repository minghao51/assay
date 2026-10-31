---
'@assay/web': patch
---

fix(web): make the grid's interaction language visible (ug-4 / UG-9, UG-33).
The ready grid now carries a persistent one-line editing hint, byte-exact:
`Double-click a cell to edit · Enter edits the focused cell · Esc cancels`. It
is visible text (never `visually-hidden`, never dismissible), it sits outside
the `role="grid"` element (whose owned children stay rows/rowgroups, UX-9), and
it is that element's `aria-describedby` description — so assistive tech gets the
same three-gesture grammar a sighted newcomer does. The footer gains a second
native disclosure beside `Diagnostics`: `<details
data-testid="grid-keyboard-help">` with `<summary>Keyboard</summary>`, collapsed
by default and keyboard-operable, listing only shortcuts this renderer actually
implements, grouped edit (double-click / Enter on a cell / Esc), inspect (Enter
on a row) and navigate (arrows, Home/End, Ctrl+Home/End, Tab). Every advertised
line is traced to the handlers in `DataGrid.tsx`; nothing aspirational is
listed. Both elements are capability-gated per instance: the hint and the Edit
group render only when editing is wired, Inspect only with a record opener, and
Navigate only when the grid is a keyboard surface — the read-only pipeline node
preview therefore shows no hint, no disclosure and no `aria-describedby`,
instead of claiming interactions it does not have. The hint id is per-instance
(`useId`) because the pipeline node preview
reuses this renderer and ARIA idrefs must stay unique (axe
`duplicate-id-aria`). No new key handlers, no change to the grid role/rowgroup
structure or to DOM order inside it, no change to the `Diagnostics` disclosure,
no new dependency, no telemetry, and copy stays value-free (ADR 0025). Pins: a
focused component spec (byte-exact hint, `aria-describedby` resolution,
per-instance ids, pinned shortcut groups on the editable grid, plus
inspect-only and preview-shaped read-only absence pins) and one e2e leg
proving the hint on
first ready paint plus the keyboard-opened shortcut list.
