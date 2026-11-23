# UX-D2 / uxv-6 / R-6 — SQL sizing evidence (2026-11-23)

**What this is:** the trigger-1 measurement for R-6 ("a dated journey or measurement showing a real
task impeded by the fixed SQL pane at a supported viewport",
[ux/runtime briefs](20261122-h1-ux-runtime-briefs.md) §R-6). One measured journey, three supported
viewports, recorded facts.

**Verdict (one line): trigger 1 not satisfied — no task was impeded** at 1024×700, 1440×900 or
1920×1080. The fixed pane is exactly the documented 320/360px, and every step of a long-statement /
wide-result task could be completed inside it with the controls and gestures the app already ships.
D-08 = A therefore stands, now with evidence on file instead of "No evidence". §6 states what this
record does **not** establish.

## 1. Environment and method

| Item          | Value                                                                                                                                                                                                                                   |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository    | `/home/howt/work/dataworkbench`, `main` clean at `ad59527`; `fc788f5` (docs-only, +1 file under `docs/process/handoff/`) landed mid-measurement and touches no source                                                                   |
| Build         | `pnpm build` → turbo, **12/12 tasks cache-hit** (`FULL TURBO`, 0.8s), i.e. `apps/web/dist` is a cache-verified build of the current source                                                                                              |
| Served        | `pnpm --filter @assay/web exec vite preview --port 4373 --strictPort` (the command `playwright.config.ts`'s first webServer uses, free port, nothing else listening on 4373)                                                            |
| Node / pnpm   | 24.13.0 / 11.26.0                                                                                                                                                                                                                       |
| Browser       | Chromium **153.0.8010.12** (Playwright 1.63.0), headless, devicePixelRatio 1, page zoom 100%                                                                                                                                            |
| Viewports     | 1024×700, 1440×900, 1920×1080 (set with `page.setViewportSize`, measured from `window.innerWidth/innerHeight`)                                                                                                                          |
| Fixtures      | `fixtures/csv/wide.csv` (20 columns × 3 rows, committed) for the wide result; `fixtures/parquet/wide.parquet` (4 columns × 1000 rows, committed) for result-dense rows                                                                  |
| Native DuckDB | 1.5.5 only to confirm fixture shape (`DESCRIBE`/`count(*)`); the app itself runs its bundled DuckDB-WASM                                                                                                                                |
| Harness       | `/tmp/uxd2/playwright.config.ts` + `measure.spec.ts`, `journey.spec.ts`, `pass3.spec.ts`, `pass4.spec.ts` (outside the repo); raw output `measurements.jsonl`, `journey.jsonl`, `pass3.jsonl`, `pass4.jsonl`                            |
| Picker path   | The hidden-`<input type="file">` fallback, armed by deleting `window.showOpenFilePicker` in an init script — the same pattern every repo e2e spec uses (`tests/e2e/support/fixtures.ts`); the FSA picker cannot be driven by Playwright |
| Screenshots   | `/tmp/uxd2/*.png` (named per row below). **Not committed** — binaries stay out of the repository                                                                                                                                        |

Each pass re-ran from a cold page (nothing reused between viewports); the first pass was re-executed
after `pnpm build` and reproduced every recorded number byte-for-byte (chars/line, visible columns,
scroll ranges, geometry tracks), so the table is deterministic and not a lucky frame.

**The task, as a user does it** (identical at every viewport):

1. `Open a data file…` → `fixtures/csv/wide.csv`; the Explore task's `SQL` section is opened from its
   own `SQL` toggle.
2. **Long statement** — 350 characters, 14 lines, a `CASE` chain plus a 19-element `IN` list, run with
   `Ctrl`+`Enter` (also clicked via `Run`):

   ```sql
   SELECT
     col_01,
     CASE
       WHEN col_01 = 1 THEN 'alpha-bucket'
       WHEN col_01 = 2 THEN 'bravo-bucket'
       ELSE 'charlie-bucket'
     END AS bucket_label,
     col_05,
     col_12,
     note
   FROM "assay_t1"
   WHERE col_02 IN (2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38)
     AND note IN ('alpha', 'bravo', 'charlie')
   ORDER BY col_01, note
   ```

3. **Second long statement, single line** — a 178-character `IN`-list statement, to test the
   worst case for wrapping (one unbroken line).
4. **Wide result** — `SELECT * FROM "assay_t1"` over the 20-column fixture → the 20-column result; then
   attempt to read the row-distinguishing `note` column (20th) and the row identity `col_01` (1st).
5. **Dense result** — the same section over `fixtures/parquet/wide.parquet` (1000 rows, page = 50) to
   measure how many rows the result frame shows.

## 2. Per-viewport measurements

### 2.1 Pane width against the documented bounds

| Viewport  | `workbench-layout` tracks (measured) | Pane rect width | Pane content (clientWidth) | Editor rect / content width | Documented bound (`docs/product/05-workbench-shell.md` §3, uxv-3) | Match |
| --------- | ------------------------------------ | --------------- | -------------------------- | --------------------------- | ----------------------------------------------------------------- | ----- |
| 1024×700  | `320px 656px`                        | 320px           | 318px                      | 272.8px / 258.2px           | 320px at 1024–1199px                                              | exact |
| 1440×900  | `360px 1016px`                       | 360px           | 358px                      | 312.8px / 298.2px           | 360px at ≥1200px                                                  | exact |
| 1920×1080 | `360px 1496px`                       | 360px           | 358px                      | 312.8px / 298.2px           | 360px at ≥1200px                                                  | exact |

The pane stops growing at 360px while the grid column grows to 1496px — that is the documented
fluid rule, not a deviation. No measurement here exceeds 320/360px, so nothing measured argues for
exceeding the spec bounds.

### 2.2 Long statement in the editor

| Viewport  | Editor font / char advance      | Usable text width | **Chars per line** | Statement (350 chars / 14 lines)                          | Horizontal scroll in editor                    | Vertical scroll                                 | Longest line 88 chars becomes |
| --------- | ------------------------------- | ----------------- | ------------------ | --------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------- | ----------------------------- |
| 1024×700  | 13.6px `ui-monospace` / 8.184px | 258.2px           | **31**             | editable, text intact (350 chars read back after the run) | **no** (`scrollWidth` 271 = `clientWidth` 271) | yes, 317px content in 77px, `scrollTop` max 240 | 3 wrapped lines               |
| 1440×900  | same                            | 298.2px           | **36**             | same                                                      | **no** (311 = 311)                             | yes, same                                       | 3 wrapped lines               |
| 1920×1080 | same                            | 298.2px           | **36**             | same                                                      | **no** (311 = 311)                             | yes, same                                       | 3 wrapped lines               |

- The textarea is `white-space: pre-wrap` (`wrap` attribute unset), so the statement never forces
  horizontal scrolling: 31/36 characters per line is the whole story, and every longer line wraps.
- The single-line 178-character `IN`-list statement at 1024×700 wraps to **6 visual lines** with no
  horizontal scroll — the worst case for this pane, and it stays readable.
- The editor ships `resize: vertical`; a real pointer drag on its own handle took the visible height
  from **78.8px to 237px** at 1024×700 with no horizontal scroll. Long statements can be worked
  vertically inside the delivered pane without touching its width.
- Height, not width, is the constraint while editing: `rows={4}` shows 77px (~4 lines), so a 14-line
  statement scrolls vertically. This is a 4-row textarea at every viewport, including 1920×1080 —
  a property of the editor, not of the pane's width.

### 2.3 Wide result set (20 columns)

| Viewport  | Result region width (client) | Table width (`scrollWidth`) | Horizontal scroll range | **Columns fully visible**       | 5th/6th column   | Reader `note` column                     |
| --------- | ---------------------------- | --------------------------- | ----------------------- | ------------------------------- | ---------------- | ---------------------------------------- |
| 1024×700  | 271px                        | 1136px                      | 865px                   | **4 of 20** (`col_01`…`col_04`) | `col_05` partial | off-screen initially, reached by panning |
| 1440×900  | 311px                        | 1136px                      | 825px                   | **5 of 20** (`col_01`…`col_05`) | `col_06` partial | off-screen initially, reached by panning |
| 1920×1080 | 311px                        | 1136px                      | 825px                   | **5 of 20** (`col_01`…`col_05`) | `col_06` partial | off-screen initially, reached by panning |

- Individual column width is 56.7px (`col_01`…`col_19`) / 58.9px (`note`), set by the cell padding and
  the 0.85rem type size, not clipped or ellipsised at these values.
- **The results grid does scroll horizontally** at all three viewports (`overflow: auto` on
  `.sql-result`), and the panning is reachable by real input, measured at 1024×700:
  - **Shift+wheel over the result** moved `scrollLeft` 0 → 400px in one 400px gesture (`journey.jsonl`
    `shift-wheel 1024x700`);
  - **keyboard**: the region is `role="region"` + `tabIndex=0`, so it is focusable and pans to
    `scrollLeft` = 865px = the maximum; at maximum pan the visible headers are `col_16`, `col_17`,
    `col_18`, `col_19`, `note`, with `note`'s right edge at 311.5px against a 310.6px scrollport edge
    (inside the viewport, sub-pixel rounding only).
- Headless Chromium reports `offsetHeight − clientHeight = 2px` for the region (borders only), i.e.
  overlay scrollbars that reserve no gutter — the pan gesture, not a permanent 15px scrollbar, is the
  discovery path. That is a property of the result frame's overflow, identical at 320px and 360px.
- **The one real friction, stated plainly:** while panned to `note`, the identity column `col_01` is
  scrolled out of view, and there is no frozen first column. Reading a 20-column result at 320px means
  panning ~2.8 region-widths back and forth. It is workable (panning is reachable by wheel and by
  keyboard, both measured) — but it is the closest thing to "impeded" observed, and §5 records why it
  does not meet trigger 1.

### 2.4 Outcome/status line and row density

| Viewport  | `sql-status` text | Status clipped?  | Pager label              | Pager clipped?   | Rows rendered (1000-row fixture, page 50) | **Rows fully visible** | Result frame height | Vertical scroll range |
| --------- | ----------------- | ---------------- | ------------------------ | ---------------- | ----------------------------------------- | ---------------------- | ------------------- | --------------------- |
| 1024×700  | `Done`            | no (34px = 34px) | `rows 1–3` / `rows 1–50` | no (56px = 56px) | 50                                        | **11**                 | 318px               | 947px                 |
| 1440×900  | `Done`            | no (34px = 34px) | `rows 1–50`              | no (56px = 56px) | 50                                        | **11**                 | 318px               | 947px                 |
| 1920×1080 | `Done`            | no (34px = 34px) | `rows 1–50`              | no (56px = 56px) | 50                                        | **11**                 | 318px               | 947px                 |

The row-count/status line is legible and unclipped at every viewport; the `End of results — this page
had fewer rows than a full page.` note (visible in the decisive screenshot) is equally unclipped. The
11-visible-rows figure is set by `.sql-result { max-height: 320px }` — a **height** choice that is
identical at 320px and 360px pane widths, so wider SQL sizing would not change it.

### 2.5 Can the statement and its result be on screen together?

| Viewport  | SQL section height | Pane content height | Section fits pane | Editor visible  | Result visible  | Pager visible |
| --------- | ------------------ | ------------------- | ----------------- | --------------- | --------------- | ------------- |
| 1024×700  | 573px              | 682px               | **yes**           | yes (282–361px) | yes (409–511px) | yes           |
| 1440×900  | 554px              | 882px               | **yes**           | yes             | yes             | yes           |
| 1920×1080 | 554px              | 1062px              | **yes**           | yes             | yes             | yes           |

Measured after the two ordinary scrolls a user makes anyway: the window scrolled to the workspace and
the tool pane scrolled so the SQL section starts at its top (`scrollTop = section.offsetTop − 8`). At
the smallest supported viewport the editor, its `Run`/`Cancel`/`Done` row, the result table and the
pager are simultaneously inside the pane and inside the window — the statement being edited and the
rows it returned do not have to be traded against each other.

The screenshots that show the condition (or its absence):

| File (`/tmp/uxd2/`)                                                                 | What it shows                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `1024x700-together.png`                                                             | **The decisive frame.** 320px pane, wrapped case/`IN` statement, `Done`, 3-row result with `col_01`…`col_12`, pager `rows 1–3`, "End of results" note — all readable on one 700px-tall screen |
| `1024x700-journey-3-wide-run.png`                                                   | Immediately after `Run` without any extra scroll: the result sits below the pane's visible area — the user scrolls the pane; nothing is clipped or unreachable                                |
| `1024x700-journey-4-panned-pane.png`                                                | The 20-column result at maximum pan at 320px: `col_16`…`col_19` + `note` readable                                                                                                             |
| `1024x700-wide-result.png`, `1440x900-wide-result.png`, `1920x1080-wide-result.png` | Full page after the wide query at each viewport                                                                                                                                               |
| `1024x700-in-list-resized.png`                                                      | The single-line 178-char statement wrapped, after a pointer drag made the editor 237px tall                                                                                                   |
| `1024x700-row-density.png`, `1440x900-row-density.png`                              | 50-row page: 11 rows in the 318px result frame                                                                                                                                                |

## 3. Verdict

**Trigger 1 not satisfied — no task was impeded.**

Three candidate blockers were exercised and none blocked:

1. **Long statement** — 350 chars / 14 lines, and a 178-char single line, are editable, wrap at 31/36
   chars per line with **no horizontal scrolling at any viewport**, stay intact across a run, and can
   be given more height by the editor's own shipped vertical resize. Height (4 rows) is the only
   pressure, and it is the same at 1920×1080 as at 1024×700 — a textarea property, not a pane-width
   one.
2. **Wide result** — 20 columns show 4 (320px) / 5 (360px) at a time with the rest reachable by
   Shift+wheel and by keyboard (`tabIndex=0`, pans to the 865px maximum), and the outcome/status copy
   is legible and unclipped. Panning is required and the identity column leaves the view while panned;
   that is friction, not a task that "cannot be worked in the delivered pane".
3. **Dense result** — 11 of 50 rows visible in the 318px frame, identical at both pane widths; a
   wider SQL pane would not add a single row.

The pane measures **exactly** the spec'd 320px / 360px, so no measurement here shows the delivered
width deviating from `docs/product/05-workbench-shell.md` §3.

## 4. What would settle it, if anything can

If a maintainer believes the 20-column pan-and-lose-the-key-column behaviour above is a real task
impediment, the honest framing is that trigger 1 asks for a task that **cannot** be worked, and this
measurement found the opposite: every path completed. A stronger future submission would need a
concrete, named task where panning is not merely annoying but fails — e.g. a required side-by-side
comparison of two columns that the pane cannot present at any supported viewport **and** that has no
reachable alternative in the shipped UI. Nothing in this measurement is that.

## 5. Why the friction does not reopen the row

R-6's own evidence rule is "a real task impeded by the fixed SQL pane". What was observed is
"a 20-column result needs panning in a 320px pane", which is true at 360px too (5 of 20 columns
instead of 4 — one extra 56.7px column), and R-4's stop rules plus the uxv-6 row forbid using layout
preference, density taste or roomy-board mockups as evidence. Recording it as "could be better" is
exactly the softening the brief forbids. **The row stays decided-not-now, and this time with a dated
measurement on file** rather than the 2026-11-21 "No evidence" assertion.

## 6. What this does not establish

- **Trigger 2 is untouched.** No maintainer instruction that the sizing direction is wanted was
  sought, received or implied; the orchestrator's delegation to run this measurement is **not** that
  instruction. D-08 = A is unchanged.
- **No spec amendment.** Nothing here approves, drafts or pre-approves a change to
  `docs/product/05-workbench-shell.md` §3, the uxv-6 shape (adjustable limits, minimum grid width,
  keyboard resize/reset, below-breakpoint behaviour, test plan), ADR 0044, or WF-03/WF-08/WF-04.
- **No copy change.** The SQL outcome copy pinned by the EW-02 scope contract §3.2 was read only
  (`Done`, `rows 1–n`, `End of results — this page had fewer rows than a full page.`); nothing was
  reworded or proposed.
- **No aesthetics, density or "roomy board" claim.** No claim that the pane is well-proportioned,
  dense, comfortable or that a wider pane would be nicer. Those are explicitly not evidence.
- **No full-surface coverage.** Measured at 100% zoom, DPR 1, one browser (Chromium 153), the Explore
  task's SQL section, two committed fixtures. 200% zoom, other browsers, the CSV/JSONL sniffing
  paths, cancel/error states, keyboard-only journeys beyond the pan gesture, and the below-1024 stack
  were not re-measured here.
- **No runtime change and no runtime revalidation claim.** This record is documentation only; it did
  not modify any source file and ran no test suite.
