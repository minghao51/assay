# rd-1 redesign prototypes — task navigation and the repair journey

**Design-checkpoint artifacts, 2026-11-04.** Two isolated, self-contained HTML prototypes for the workbench redesign comparison (rd-1). They are **not** shipped UI, **not** screenshots of the product, and **not** evidence that the product is intuitive. No participant testing was performed. Read the [design record](../../docs/product/13-workbench-redesign-design-record.md), the [usability protocol](../../docs/process/handoff/20261104-rd2-usability-protocol.md) and the [stack/UX review](../../docs/product/12-workbench-redesign-review.md) first.

## Open them

No build, server, dependency or network access is required:

```bash
# any of these works; the files are standalone
xdg-open assests/prototypes/rd-nav-a.html
python3 -m http.server 8080 --directory assests/prototypes   # then open /rd-nav-a.html
```

Both use inline `<style>`/`<script>` only. There are no external fonts, images, scripts, links or network requests, and no storage. Every value is synthetic.

## The two alternatives

| File                                       | Alternative                                             | What changes                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------ | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`rd-nav-a.html`](rd-nav-a.html)           | **A — incremental navigation** inside the current shell | Nav grouped into Explore / Check / Change / Prepare over the existing 12 anchors; one dataset context bar above the grid; a next-action state machine; a `Back to findings` chip. Pane DOM, headings and section order stay as today.                                                                                                                                                    |
| [`rd-task-led-b.html`](rd-task-led-b.html) | **B — task-led workbench** (recommended IA)             | Four single-select tasks (real radio-group semantics) controlling which tool sections are visible at ≥1024px; sections stay mounted; context bar beside the grid; same next-action model; no per-task count badge (the bar names the consequence/action without copying the count; the verdict and the section summary keep the numbers); narrow 900px mode keeps every section stacked. |

Both prototypes model the same primary journey: **contract → validation finding → logical row → typed repair → stale verdict → explicit recheck → reviewed copy**, plus comparison continuation and export/recovery states.

## How to drive them

Each page has its own harness outside the simulated app frame:

- **Scenario** — six states: no contract, failing verdict, stale after repair, rechecked valid, comparison stale, export.
- **J2 walkthrough** — steps 1–7. Each step drives the state, scrolls to the relevant control and prints the intended observation. Step 4 opens the typed cell editor on row 5; commit with Enter.
- **Annotations** — on by default; dashed boxes explain which behaviour is prototype scaffolding, which is quoted from the current source, and which decision it depends on.
- **Narrow 900px** — in A the frame just narrows; in B the task strip becomes a group jump list and every section stacks (ADR 0044's narrow contract, unfiltered).
- **Reset** — returns to scenario 1.

Keyboard: Tab/Shift+Tab through native controls; in B the task strip is a radio group with ←/→/↑/↓ and Home/End; Enter edits the focused `fund_size` cell; Escape closes the record dock or the export dialog (except while the export is writing, matching the production dialog).

## What these artifacts do and do not prove

They demonstrate **structure, copy and state transitions** for a design decision. They do not exercise the real grid renderer, engine, worker, session hooks, validation/diff bytes, export pipeline, dark scheme, production focus management or performance. Round 2 of the study must run on the built rd-4 slice.

Data and copy caveats: all rows, counts, filenames and rule outcomes are synthetic; the two prototypes use illustrative but different row names. Labels marked as quoted in the page annotations are taken from source at revision `bba491a`; everything else is prototype commentary.

## Source basis

Composition and copy were derived from `apps/web/src/App.tsx` (`WORKBENCH_SECTIONS`, `WORKBENCH_SECTION_PURPOSES`, `WorkbenchSection`, pane/nav, grid/record, export wiring), `validation/ValidationPanel.tsx`, `diff/DiffPanel.tsx`, `export/ExportDialog.tsx`, `edit/HistoryPanel.tsx`, `edit/EditToolbar.tsx` and the design tokens in `apps/web/src/index.css`. The prototypes add no dependencies and change no production code.
