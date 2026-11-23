# WFD selections — R-1, R-2, R-3, R-4 (2026-11-23)

**Base:** `main` at `ad59527`. **Authority:** the maintainer delegated judgement for the remaining
items on 2026-11-23 ("proceed with your best judgement for the remaining items, don't wait for my
approval"). This record is where those selections are **named, given their consequences, and kept
reversible in one place** — the [successor queue](20261121-successor-queue.md) §8.2 precedent.

**What this record is:** option selections inside each row's own recorded option set, using the
row's own wording and constraints. **What it is not:** an implementation, an amendment to any
product document, a spec change, an ADR, or a usability claim (D-02 A / RD-T07 still forbid
"validated", "intuitive", "easier" and anything equivalent). A selection authorises a dispatch; it
does not close a row, and a row closes only with its evidence, gates and ledger line.

| Row | Gate owned by      | Selection                                                                    | Authorises                                         |
| --- | ------------------ | ---------------------------------------------------------------------------- | -------------------------------------------------- |
| R-1 | WFD-05 (map §2)    | **Subparts 1, 2, 3 — subpart 4 deferred**                                    | One implementation dispatch (App.tsx + scoped CSS) |
| R-2 | WFD-03 (map §2)    | **Option A**, with D-06 = **no**, D-11 = **no**                              | The row itself — no code is missing (see §3)       |
| R-3 | WFD-07 (map §2)    | **Option A**, with the state contract in §4                                  | One implementation dispatch (DataGrid + tests)     |
| R-4 | WFD-04 (map §2)    | **Option A** — commission the WF-08 study                                    | A study. **No runtime authority follows.**         |
| R-5 | contract (not WFD) | **Commissioned** — contract + real-engine probes; item 3 gated on the probes | Contract drafting and probe work, not runtime      |
| R-7 | contract (not WFD) | **Drafted, escalated** — item 3 needs an architect ruling                    | Contract drafting, not runtime                     |
| R-6 | evidence (not WFD) | **Not selected** — trigger 1 is being measured; trigger 2 was not exercised  | Nothing (see §8)                                   |

## 1. R-1 — WFD-05, WF-03 shell/panel presentation

**Selected:** subparts **1** (Help opener moves beside Settings), **2** (hierarchy cleanup by
style/spacing only, h2s stay), **3** (idle-only welcome assembled from **existing** `IDLE_*`
strings). **Deferred: subpart 4** (new first-minute strings).

**Why 4 is deferred rather than approved.** The row's own gate says the candidate strings must be
re-truth-checked against delivered behaviour before approval, and that re-check now **fails**: the
first candidate, `Session changes are not saved automatically. Export a copy to keep them.`, already
ships byte-identically as WF-06's `REPLACE_GUARD_BODY_EXPORT`
(`apps/web/src/replace/messages.ts:26`), so approving it again is duplication; and the second,
`Opening another dataset replaces this session.`, was written before WF-06's guard landed — WF-06 now
ships `REPLACE_GUARD_BODY_STAYS` (`messages.ts:30`: "If you cancel the file chooser, or the file
cannot be opened, this session stays as it is."), so the candidate is no longer the whole truth.
Approving subpart 4 as written would be a copy-accuracy regression dressed as progress. Subparts 1–3
add **no** new strings.

**Consequences and what the implementing dispatch must hold:** no copy change; no centre/pane change
(ADR 0044); the heading map and `App.headings.test.tsx` pass **unchanged** (subpart 2 is style and
spacing only); the Help move keeps its opener-position and focus-return assertions and adds no
duplicate responsive Help button; the idle welcome uses only existing strings and leaves Open /
example / drop available after failures; the 1024×700 ready-top pins and `shell-geometry.test.ts`
stay green; if `index.css` is touched, both telemetry legs are required (spec §6.2).

**Falsifier:** the Help move or the idle insertion pushing the ready-workspace top past its ≤140px
budget at 1024×700 badly enough to need a geometry decision — then subparts 1/3 come back to the
maintainer instead of being landed by default.

## 2. R-3 — WFD-07, visible row range

**Selected: option A**, with the exact copy the row records (spec §4.6):

- ready: `Visible rows X–Y of N`
- empty: `No rows`
- unknown/loading: `Row range unavailable`

**State contract approved as a unit:** zero rows; a single row; all rows fitting → `1–N` (not the
overscanned window); a middle scroll → `X–Y`; the end clamp; a filter with no results; a sort
reorder; inserted/deleted/undone rows; loading/unknown total; resize and scroll-restoration updates.
X/Y are **1-based current-view positions** of rows whose data area actually intersects the viewport,
excluding the sticky header and the `VIRTUALIZER_OVERSCAN_ROWS = 6` tail, clamped to the known
total, with a partly visible first/last row counted. Static text only — no live region, no
per-scroll announcement, no new focus target.

**Consequences:** one footer label beside the existing counters and `busyStatus`; no
`packages/grid` API expansion; no new engine count, fetch or query; no paging, selection or base-row
renumbering; the SQL page label `rows {a}–{b}` (`apps/web/src/sql/paged-query.ts`) is a different
surface and **must not** be reworded here (EW-02 §3.2).

**Falsifier:** the footer cannot hold the string at 1024×700 without breaking the uxv-3 geometry
pins — then option B (keep total-only, recorded no-op) is the honest answer and this selection is
withdrawn rather than the geometry being re-tuned.

## 3. R-2 — WFD-03, contextual next action

**Selected: option A** — keep the delivered global `check → comparison → delivery` priority. **D-06 =
no** (no new "Comparisons staged" state), **D-11 = no** (no run-origin metadata).

**The approved output set is the existing one, unchanged.** `APPROVED_COPY`
(`apps/web/src/workbench/next-action.test.ts:232`) is already an independently-authored exhaustive
cross-product, asserted complete at :300 and duplicate-free at :304, and the delivered
`deriveNextAction` precedence already matches option A. So option A approves _today's behaviour and
today's strings_: no additions, no removals, no rewording.

**Consequence — this row needs no code.** Its gate was the missing table; the table exists and is
pinned. The row therefore closes on this record plus its ledger line, not on a dispatch. Explicitly
**not** done: the `APPROVED_COPY` set is not made to import implementation constants — the row names
that as "synchronized drift" and it stays rejected.

**Falsifier:** someone wants task-aware suggestions (option B), which enlarges the cross-product by
every task × state pair and needs its own approval — that reopens the row rather than extending this
selection.

## 4. R-4 — WF-08 / WF-09 layout study

**Selected: option A** — keep [ADR 0044](../../adr/0044-workbench-shell-two-pane.md) and
commission the **WF-08 in-shell legibility study first**. Option B (prototype an alternate centre)
is **not** selected: it requires a new accepted superseding ADR that does not exist, and ADR 0044 is
never rewritten or renumbered. Option C stays prohibited.

**What this authorises and what it does not:** it authorises a **study**, not a runtime row, not a
pane-width change, and not a layout decision. The study must cover both schemes at 1024×700,
1440×900 and 1920×1080, plus the 900px fallback and 200% zoom, with fixed synthetic long/wide/sparse
cases and measured canvas bounds. **WF-09 remains blocked** on an accepted superseding ADR.

**Traps recorded so they are not re-entered:** "roomy board 03 is not approval" (map §3 sv-10); a
study that mentions SQL space does **not** reopen R-6 (R-6 has its own two-trigger test); neither
screenshots nor the study may become a usability claim (RD-T07, D-02 A); no editing or pane-width
change ships from it.

## 5. R-5 — WF-O2 temporal parity: commissioned, not selected

**Not WFD-gated.** Its gate is an approved **type-propagation contract**, and the row's own brief
says "no runtime reservation until type propagation is specified". Five contract decisions are
itemised (child-type ownership; Record-tree schema and hostile input; SQL metadata from real Arrow
field metadata and never base-table guessing; assertion disposition; fixture/perf matrix).

**Item 3 is not writable honestly without measurement.** Whether computed expressions and aliases
carry real Arrow field metadata has to be probed against the engine, WF-01P style, before the
contract can claim anything. So: commission the contract **and** the probes; do not settle item 3
first, and do not implement. WFD-06 = B (scalar temporal rules) is not reopened, and no
"all temporal displays fixed" claim may be made.

## 6. R-7 — overlay-aware profile: drafted, escalated

**Not WFD-gated.** Its gate is a maintainer decision accepting an engine/client/state consistency
contract (**D-09 = B**), and the candidate charter says "no worker may claim it, no protocol, domain,
`DataEngine` target or engine source may change until a later explicit maintainer decision".

Of its five contract items, item 3 (domain / `DataEngine` target scope) is **a ruling, not an
assumption** — it crosses package boundaries, so an integrator cannot settle it by writing prose. So:
draft the contract and escalate item 3 to the architect; implement nothing. The 500-branch refusal
must survive with readable copy, there is never a silent base fallback, both profile contracts are
never shown at once, and ADRs 0012/0025/0037/0038 stand.

## 7. R-6 — SQL sizing: still measured, not decided

**No selection is made here, and this record does not reopen anything.** The row's reopen trigger is
_either_ (1) a dated journey or measurement showing a real task impeded by the fixed SQL pane at a
supported viewport, _or_ (2) an explicit maintainer instruction that the sizing direction is wanted.
**Trigger 2 was not exercised** — a general "use your judgement" delegation is not an instruction
that this particular direction is wanted, and treating it as one would be exactly the kind of
substitution the deferral exists to prevent. Trigger 1 is being measured separately
(the evidence record being written under `docs/process/handoff/20261123-*` for this row); whatever it finds, D-08 = A stands unless a
real task is shown to be blocked.

## 8. Consequences for the queue, stated once

- **Authorised dispatches now:** R-1 (subparts 1–3) and R-3 (option A) as code; R-4 as a study; R-5
  as contract + probes; R-7 as contract draft + escalation.
- **Closed by this record alone, no code:** R-2 (option A pins delivered behaviour).
- **Still blocked and why:** R-4's runtime (WF-09 needs an accepted superseding ADR), R-5's item 3
  (probes), R-7's item 3 (architect ruling), R-6 (evidence), R-14 (the cancel op shipping, then its
  own four selections).
- **Nothing here authorises** a `docs/product/05` pane-bound change, a copy rewording outside the two
  strings named above, an ADR, a new usability claim, or a package-boundary crossing.

## 9. Reversal

Every selection above is one line in the table at the top. Reversing one means editing that table and
stating the reason in the same commit; the per-row consequences in §§1–7 make clear what a reversal
invalidates, so a reversal cannot be silent. Rows already implemented stay implemented — the
selection record is where the _next_ dispatch's authority is checked.
