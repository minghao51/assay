# Usability and visual pass — local build, 2026-11-27

**Scope:** the **local** built app. The app is **not hosted** (the Netlify project serves only the
telemetry collector), so nothing here is a hosted-app observation. **No usability claim is made**: RD-T07
is an unrun study and D-02 A forbids "validated", "intuitive", "easier" and equivalents in any document.
This is a defect and measurement record.

**Environment:** `rm -rf apps/web/dist && pnpm build` (12/12, 0 cached), served with
`pnpm exec vite preview --port 4373`, Playwright 1.63.0 headless Chromium 153.0.8010.12, DPR 1, zoom
100%. Harness at `/tmp/usability-harness/` (external to the repo), importing the repo's e2e support
fixtures — pinned DuckDB-WASM extension route, the hidden-input picker path, committed fixtures, and
runtime-staged validation/diff datasets. **30 screenshots** at three viewports in
`/tmp/usability-20261127/`; raw numbers in `/tmp/usability-20261127/measurements.jsonl`.

**States reached — 27 of 27, 0 console errors or warnings:** idle (light + dark) · opened grid with
schema · profile (column profiled) · validation with 4 of 9 rules failing · diff staged with a changed
aspect · SQL with a 317-character / 11-line statement and a 21-column result · record inspector opened
deep (`→a→b→c = 1`) · pipeline (`cli_run`, 4 nodes).

## Findings, ranked

| #   | Severity                                                    | Screen                       | Measurement                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ----------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Major — task blocked at the smallest supported viewport** | validation · pipeline · diff | The primary run control is **below the fold at first paint**: validation `Run` at `top 737` on a 700px-tall viewport; pipeline `Run pipeline` at `1038 / 985 / 1027` (only visible at 1920); diff `Run` at `2246` after staging, by which point the pane had already scrolled 525px. A user must scroll before the section's own action is reachable — and at 1920 the pipeline action still is not. |
| 2   | Minor — contrast                                            | footer                       | The `·` separator measures **4.29:1**, under the 4.5:1 AA floor for small text. Everything else measured at or above AA; no text is below 11px.                                                                                                                                                                                                                                                      |
| 3   | Minor — focus inconsistency                                 | panels                       | The design token ring (`2px solid #4a7db5`, offset 2) appears on Settings / Help / Open / CSV / task nav, but **panel run buttons and record-node toggles fall back to the UA `outline: auto 1px`** — two focus treatments in one product.                                                                                                                                                           |
| 4   | Question, not a defect                                      | page geometry                | Document height **828 / 942 / 1080** at 1024 / 1440 / 1920 → page scroll of **128 / 42 / 0px**. At 1024 the sticky tool pane (320px track, 684px tall from `y=127.9`) runs **112px past the fold**. Whether a 128px document scroll at the minimum viewport is intended is a layout decision, not a measurement.                                                                                     |
| 5   | Question, not a defect                                      | SQL                          | The pane is exactly the documented **320 / 360px** (panel rect 299 / 339). A 21-column result shows **4 / 5 headers** fully with a **971 / 931px** horizontal scroll range, and the pager `rows 1–3` sits at `top 713` — below the fold at 1024×700. Consistent with the R-6 measurement, which found the task workable but named the same friction.                                                 |

## What looked fine (a one-sided report is not evidence)

- The **`Visible rows X–Y of N` footer label** is fully inside all three viewports (673–692 at 1024),
  13.6px, **7.46:1** — the newly shipped feature reads well at the smallest size.
- Keyboard traversal reaches everything: `sql-run` is the 88th Tab stop with a 20-column fixture, which is
  high but ordered; no trap encountered.
- No console errors or warnings across 27 states, and no broken layout or clipped text observed in the
  grid, profile, record inspector or diff panels.

## What this does not establish

No hosted-app behaviour (the app is not deployed), no participant evidence, no study, and no claim about
being clearer, faster or easier. Screenshots are uncommitted artefacts of one run on one machine; the
record is reproducible from the commands above, and a re-run should reproduce these numbers before any
of them is quoted elsewhere.

## Suggested follow-ups (not authorised here)

1. **Finding 1 is the one worth acting on** — a primary action below the fold at the minimum viewport.
   It is a layout decision for the maintainer (ADR 0044 constrains the pane), not something a worker
   should re-tune unilaterally.
2. Findings 2 and 3 are small and safe: one contrast token, one focus rule.
3. Findings 4 and 5 are the R-6/R-4 territory already recorded; do not reopen them from this record.
