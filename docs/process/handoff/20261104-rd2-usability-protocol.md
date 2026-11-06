# rd-2 usability protocol — workbench redesign (prepared, not run)

**Authored:** 2026-11-04 as part of the rd-0…rd-2 design checkpoint. **Status: protocol prepared; no session has been run. There is no human usability evidence for either alternative.** Read with the [stack/UX review](../../product/12-workbench-redesign-review.md) (requirements RD-R07 and RD-T07), the [design record](../../product/13-workbench-redesign-design-record.md) and the [live implementation map](20261104-svg-implementation-map.md).

The review's own rule governs this document: a maintainer may accept the missing-evidence limitation for a limited implementation pilot, but that choice must not be described as user-validated. Nothing here authorizes participant contact, recording, telemetry, upload, payment or publication.

## 1. What this protocol is for

Decide whether the candidate task-led structure (alternative B) reduces the friction the redesign exists to remove, using the same tasks, fixture and moderator script as the current shell. It is **not** a feature-acceptance run, a benchmark against other products, or a statistically powered study.

Success is behavioural, not aesthetic:

- a participant can find a failing rule, reach its logical row, repair a typed value, notice the verdict is stale and explicitly recheck it, without being told which tool to open;
- no participant leaves with a critical misconception (source mutation, export scope, stale checks, profile origin, whether edits were saved);
- the candidate does not trade faster J2 navigation for more confusion elsewhere (J1/J3/J4).

## 2. Participants and logistics

| Item          | Plan                                                                                                                                                                                                                                                                 |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sample        | **5–8** participants, starting with 5. Include at least two newcomers to data tooling and two experienced data-tool users where available. Agree an expansion only if needed.                                                                                        |
| Recruitment   | Maintainer-organized. No external participant contact is authorized by this protocol.                                                                                                                                                                                |
| Setting       | One-to-one moderated session, 45 minutes, screen share or in person, moderator reads the script verbatim.                                                                                                                                                            |
| Materials     | The built app at one known revision (baseline), the two isolated prototypes (`assests/prototypes/rd-*.html`) for the structure comparison, and one synthetic fixture set (below).                                                                                    |
| Data captured | Anonymous aggregate notes only: completion yes/no, wrong turns, Help opens, task time, ease rating, critical misconceptions, and a live moderator action log for round-trip counting (see §5). No names, no employer data, no screen or audio recordings, no upload. |
| Retention     | Notes stay on the moderator's machine during the study and are destroyed after the aggregate table is written into the design record.                                                                                                                                |
| Consent       | Synthetic data only; participation is voluntary; stop at any point; nothing typed into the app leaves the machine; the opened example file is synthetic.                                                                                                             |
| Compensation  | Out of scope for this document; a maintainer decision.                                                                                                                                                                                                               |

**Counterbalancing:** half the participants run the current shell first and the candidate second; the other half run the reverse. Every participant sees the same fixture and the same task wording. The moderator never names a panel, section or task group in the prompt.

## 3. Materials and their gaps

| Material             | Status                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| J1 fixture           | **Available:** `fixtures/jsonl/nested.jsonl` (12 rows × 10 columns, committed synthetic data; used by the shipped example action and the rehearsal pack).                                                                                                                                                                                                                              |
| J2 contract + repair | **Partially missing.** The rehearsal used per-run temporary inputs (`writeValidationDatasetA`, `writeExitJourneyPair`) rather than a committed study fixture. Before the study, commit or document one reproducible synthetic pair (dataset A + contract) with a single failing scalar rule, so the same "repair one value → stale → recheck" path is identical for every participant. |
| J3 comparison pair   | **Partially missing** for the same reason: the M6 pair is generated per run. Reuse the documented pair or commit a study pair with a nonempty confirmed key.                                                                                                                                                                                                                           |
| J4 safety/recovery   | No fixture needed; scripted questions plus one cancelled/refused action (cancel validation; export to the source path is refused).                                                                                                                                                                                                                                                     |
| Built baseline       | Requires `pnpm build` and a fresh preview server per protocol in the [map §6](20261104-svg-implementation-map.md#6-verification-and-independent-review); no configured-telemetry bundle.                                                                                                                                                                                               |
| Candidate prototype  | The prototypes are static, synthetic and not the shipped app. They test structure and copy, **not** engine behaviour, real keyboard routing through the React grid, or performance. Round 2 must use the built rd-4 slice.                                                                                                                                                             |
| Assistive-technology | A screen-reader review (e.g. one NVDA/VoiceOver pass) and one keyboard-only walkthrough are required if available. Record absence explicitly if not.                                                                                                                                                                                                                                   |

## 4. Tasks (moderator script)

Read each prompt verbatim. Do not say "open Validation", "click Check", "use the section nav" or any other location hint. If a participant is stuck for 60 seconds, record the wrong turns and give the smallest possible nudge; the task then counts as **incomplete without direction**.

### J1 — Understand

> "Open the example data. Find the value of `meta.country` for the record whose `id` is `A-1005`. Then tell me how you would check every row's `fund_size` in one query."

Observe: which surface is found first; whether schema, grid and record stay in sync; whether the generated SQL outcome is reached; any panic from the JSON-shaped cells.

### J2 — Repair and check (primary journey)

> "A contract for this dataset is on the desktop. Load it, find one failing rule, repair the failing value in the record it names, and get back to a result you would trust enough to export. Tell me when you believe the check you are looking at describes the data as it is now."

Observe exactly the chain: contract → finding → logical row → typed repair → stale → explicit recheck. Record: was stale noticed without prompting; was the repair committed once (not twice); did the participant believe the recheck was automatic; did they try to export before rechecking; where did they look for the next action.

### J3 — Compare

> "Load the comparison file as B. Before looking at row differences, tell me which fields A and B disagree on and which key the comparison is using. Then show me one row that exists only in A."

Observe: schema-first reading; whether B staging replaced A; key confirmation understood as a proposal; whether the participant expects B rows in the grid.

### J4 — Safety and recovery

> "Without exporting, tell me which file your edit has changed. Now export a copy and then explain what the export contains if a filter was active. Finally, cancel a validation run and tell me what result you are left looking at."

Observe: original vs overlay; whole-dataset export; stale verdict after cancel; any belief that the source file was overwritten or that the session was saved.

## 5. Measures and counting rules

| Measure                   | Definition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Task completion           | Completed the stated outcome with no location hint. Denominator reported (e.g. 4/5).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Critical misconception    | Any stated belief that (a) the opened source file was modified, (b) export contains only the filtered view, (c) a stale verdict describes the current data, (d) profile statistics include staged edits, or (e) the session was saved to disk. Any occurrence fails the study gate.                                                                                                                                                                                                                                                                                                                                |
| Avoidable round trip (J2) | A navigation action that leaves the current task surface and returns without changing any state (e.g. scroll to a panel, open a collapsed section, click a nav link, then return). Counted from the moderator's **live action log** — a timestamped, paper-or-local-file list of the participant's transitions written during the session (no recording). Define the action list and the [start, end] surface for each task before the first session and keep them fixed. Two moderators independently count the first session as a calibration check; if their counts differ, restate the rule before continuing. |
| Help dependence           | Any open of the Keyboard disclosure or a Help surface, and whether it changed the outcome.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Next action identified    | Participant states the next useful action within 30 seconds of the stale state appearing, without a hint.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Ease                      | Single 1–7 rating per task ("how easy was that?"), collected after the task, plus one free-text sentence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Time                      | Wall-clock from prompt end to stated completion; median per task, never presented as a universal limit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

**Provisional exit criteria (agree before the first session, then do not move them):**

- at least **4 of the first 5** complete each core task without moderator direction, with the denominator reported;
- **zero** critical misconceptions; a single occurrence means correct the design and re-test;
- at least **4 of 5** identify the next useful action after a stale verdict without opening Help;
- median ease **≥ 5/7** per core task and **no median task-time regression** against the baseline;
- at least **20% fewer** avoidable round trips on J2 for the candidate versus the same participants' baseline, with the counting rule above;
- one keyboard-only walkthrough completed, and one assistive-technology review attempted (record absence if unavailable).

These are proposed UX targets. They are not achieved results, not statistically powered claims, and not a public-release gate.

## 6. Analysis and decision rule

1. Tabulate per participant: order (baseline-first / candidate-first), task completion, round trips, time, ease, misconceptions.
2. Report counts and denominators; never invent a percentage from five people.
3. Classify wrong turns: (a) could not find the tool, (b) found the tool but lost the finding context, (c) did not notice stale, (d) expected automation, (e) misunderstood scope/safety, (f) keyboard/focus obstacle.
4. Compare only within participant (baseline vs candidate) and report the raw table.
5. **Decision rule:** adopt B only if it meets the J2 round-trip and next-action criteria and produces no critical misconception. If it ties or loses on J2 but improves nothing elsewhere, keep A (the incremental alternative) and stop. If both fail, return to the design record rather than adding surface polish.
6. Record the limitation of any accepted gap (sample size, missing AT, prototype vs built app) next to the result. A maintainer acceptance of the limitation is recorded explicitly and never labelled "user-validated".

## 7. Autonomous heuristic walkthrough — performed 2026-11-04 (not human evidence)

Because no participants were available in this checkpoint, two agent sessions performed a structured heuristic/cognitive walkthrough of the current source and both prototypes. This is **not** usability evidence and must not be reported as such. Its only purpose is to find obvious design faults before spending participant time.

Method: for each of J1–J4, walk the intended path in each prototype, then in the source-derived current shell (source reading plus the existing browser specs' assertions, not a fresh user run); list every point where the next action is not visible, where the return path is lost, or where a state caption could mislead.

Findings that changed the candidate design:

1. **A stale count is not an action.** The current Validation panel's stale banner is text; the rerun is the panel's primary `Validate` button, which is in a different visual block. Both prototypes add one explicit stale action beside the data (context bar) while keeping the banner and the existing button. This is a copy/affordance change, not a new run path.
2. **A finding jump loses its origin.** `Show row` opens the record dock and scrolls the grid, but nothing records where the user came from. Both prototypes add an app-local "Back to findings" chip; no session data is captured.
3. **Twelve equal-weight peers hide the task.** The nav can be reordered (ug-22) but not grouped; the pane's sections are ordered for construction, not for a journey. Alternative B groups them, and the walkthrough found that grouping must not hide the state: the context bar names the consequence and the action, the panel verdict keeps the detailed count, and the existing section summary keeps the local collapsed count. The bar deliberately does **not** repeat the number (and no per-task badge was added), because three copies of "1 failing" read as three separate alarms.
4. **The default first paint shows only the grid expanded.** A newcomer must discover that tools are collapsed. B keeps Schema visible in Explore and makes the context bar name the next check action; it does not auto-switch the task.
5. **Keyboard paths cross task boundaries.** In the prototype, `Show row` from Check focuses the record dock's Close button; Escape returns to the grid row. Keyboard activation of a task choice keeps focus on that choice; the prototype stores a per-task focus target but does **not** restore it, so per-task focus restoration is a proposed implementation detail to test, not prototype behaviour. The walkthrough flagged that a task switch must never move focus silently — hence: move focus only on keyboard activation, never on a mouse click, and never into hidden content.
6. **A narrow viewport would break a filtered task strip.** The recommendation therefore keeps every section stacked at <1024px (no filtering) so ADR 0044's narrow contract is unchanged; the prototype's 900px mode demonstrates this.
7. **Export is already honest; do not "improve" it into a step.** The dialog already states the whole effective dataset and the staged count. The redesign should keep the dialog and only make the entry point easier to find from the repair journey.

Unknowns that only a participant can settle (recorded, not guessed):

- whether "Check" / "Change" are the right task names for this audience;
- whether a persistent context bar is read as status or as a banner to dismiss;
- whether the task strip is discovered before the section list;
- whether the stale action beside the grid is found before the panel's own stale banner;
- whether an experienced user finds the grouped pane slower than the current flat list.

## 8. Missing-evidence register

| Evidence                                 | Status                               | Consequence                                                                |
| ---------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------- |
| Moderated participant sessions           | **Missing** (0 run)                  | RD-T07 unsatisfied; design selection is a recommendation, not validation.  |
| Keyboard-only human walkthrough          | **Missing** (agent walkthrough only) | Must run before rd-4 closes.                                               |
| Assistive-technology review              | **Missing**                          | Required where available; record absence explicitly.                       |
| Candidate as built app (not prototype)   | **Missing**                          | Round 2 must run on the rd-4 slice; prototype results are structural only. |
| J2/J3 committed study fixtures           | **Missing**                          | Must be created/documented before the first session.                       |
| Dark-scheme / 200% zoom participant pass | **Missing**                          | Covered by automated gates only; not a substitute for observation.         |

No participant was invented, no result was inferred from automated tests, and no automated test is presented as user validation.
