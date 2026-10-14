# What's next — post-queues state (2026-10-11)

**Orientation record, written 2026-10-11 at BOTH-QUEUES-CLOSED so the next human/agent session
starts here.** Authority chain: [`handoff.md`](../handoff.md) (the living entry point) → **this
file** (the what's-next snapshot) → the closed queue files (records — annotated, not archived:
[20261002-p3-queue.md](20261002-p3-queue.md) ·
[20261002-ptv-slice1-queue.md](20261002-ptv-slice1-queue.md)). Docs-only — authored by the
orchestrator per [operating-model.md](operating-model.md) §7.5; no code, no changeset.

**Baseline:** `main` = `1e7cc76`, tree clean — unit **2938**/180 files, coverage
**89.17/83.33/89.2/90.72** (thresholds 83/76/80/84), changesets **151**, docs:links **103** files/0
broken. Both queues CLOSED 2026-10-11: **P3** (p3-1, p3-1b, p3-2…p3-5 — 6/6, last row `bfc33b4`)
and **PT-V slice 1** (ptv1-1…ptv1-5 — 5/5, last row `79ec35d`).

## 1. The serialized lane — empty, and what re-arming it takes

**No active queue.** Nothing is dispatchable from a queue row right now.

**The lane's next tenant is PT-V slice 2** — the candidates are already recorded (NOT queued) in
the [slice-1 §5 closure](20261002-ptv-slice1-queue.md), per the ptv1-4 out-of-slice record:

- **Edit in VS Code** — the overlay editing surface
  ([ADR 0012](../../adr/0012-edit-overlay-and-transaction-semantics.md)) on the webview grid:
  inline cell edits, insert/delete row, dirty markers, undo/redo, engine-rejection alerts.
- **Validate in VS Code** — the M5 validation surface in the webview (plan → verdicts → report)
  over the same engine client.
- **Diff in VS Code** — **MVP scenario 11 = the track exit** ([product/04 §3/§5](../../product/04-post-mvp-track.md)):
  staged comparison, confirm-to-run key selection, export ≡ CLI.
- **Git context** — branch/working-tree dataset context in the VS Code surface.
- **The dataset diff command** — a VS Code command entry into the diff surface (per ptv1-4's
  out-of-slice record).
- Settings/UI polish.

**Authoring a slice-2 queue is a docs-only orchestrator/maintainer step** (the 2026-10-02
queue-authoring precedent — [§9 eg](../handoff.md)): rows + done-when + STOP boundaries off the
candidate list above, honoring **D18** (vscode-web stays RE-SCOPE and out of scope —
[rulings file](20260926-maintainer-rulings.md)) and the **D17/D19** binding answers. **Not
authored yet — do not dispatch rows that don't exist.**

**vscode-web re-scope spike note (recorded, NOT queued):** the
[R4 report §8](../../engineering/08-vscode-webview-feasibility.md) names the settle path — one
focused spike with `@vscode/test-web` measuring the host-integration unknowns (browser extension
entry point, session-scoped webview origin / OPFS durability, the iframe COOP/COEP posture).
Slice 1's landed vendored bootstrap is browser-shaped webview-side code, so such a spike would
ride it directly — it could convert RE-SCOPE to a GO/NO-GO or keep it parked; a candidate for a
future slice or the PT-H lane.

## 2. Dispatchable without new authoring: PT-Q residue

Three items are pickup-ready in [product/04 §7](../../product/04-post-mvp-track.md) — that §7's
pickup protocol governs (one item per dispatch, standard definition of done):

- **q-14 — diff reserved-column projection check across UNION arms** (the q-12 carry-over):
  `projectionIdentifiers` inspects only the region before the first depth-0 `FROM` while
  `isSingleSelectStatement` permits `UNION`, so a second arm omitting the reserved columns passes
  the gate and fails mid-op (reviewer-probed 2026-09-26; pre-existing since before q-12).
  Done-when: every UNION arm's projection is checked (reuse `splitTotalsArms`), spoof +
  wrong-arity probes pinned.
- **q-5b — e2e hygiene remainder** (the q-5 close carry-over): the remaining spec-local helpers
  (`openFlatFixture`, `clickAndGetJson` ×2, three `openNestedFixture` copies) consolidated into
  `tests/e2e/support/`.
- **q-7 slice 2 — tooling-strictness remainder**: `noUncheckedIndexedAccess` +
  `exactOptionalPropertyTypes` on `packages/testing` (5 own errors + 12 spilling into
  contracts/validation/diff sources compiled through its program).

## 3. Human-gated (not agent work): the G0 tail

The standing list from [handoff.md §6](../handoff.md) — none of this is dispatchable agent work;
[manual-actions.md](../manual-actions.md) is the human track:

1. **Telemetry collector deployment** — the G0 prerequisite is code-complete (t-1…t-3 landed
   2026-09-29); deployment is the maintainer's.
2. **Public disclosure** — the public-facing counterpart of the landed first-run disclosure.
3. **npm org claim** — `@assay` scope must be ours before first publish (M1, the D6 tail).
4. **Trademark/domain clearance** (M4).
5. **Org transfer + public flip** — the repo is private under `minghao51/assay`; both are
   maintainer calls.
6. **Publish-readiness day** — rides manual M1; the
   [runbook](20260926-publish-runbook.md) is dry-run-validated (2026-09-26).

## 4. Banked micro-items (root-config-touch class)

Both were deliberately kept OUT of the PT-V rows (root config was out of scope there) and banked
for whenever a root-config touch is next permitted:

- **One-line root `.prettierignore` for `apps/vscode/assets/duckdb/**`** — the ptv1-2
  `.pinned`-suffix workaround: root `pnpm format` rewrote the vendored worker js (the checksum
  gate caught it); canonical names are restored at build. Origin: ptv1-2 deviation (1) +
  [§9 er](../handoff.md).
- **Pure-logic vitest extraction** — `formatFromName`, the extension map, error-kind mapping:
  the ptv1-3 structural-coverage note (the root vitest include `apps/*/src/**` puts the
  vscode-API-bound files at 0% in the denominator — pure dilution, covered total steady at
  15621). Origin: ptv1-3 carry-note (c) + [§9 es](../handoff.md).

## 5. Environment notes for the next session

- **Roster drill:** probe the pinned Go lanes (worker `deepseek-v4.1-flash` / reviewer
  `mimo-v2.6-pro`) ONCE per session (cheap) — they 429'd (`GoUsageLimitError`) every cycle
  2026-10-10→11; the rotated scout roster ran them all: **scout-as-worker + fresh-session scout
  reviewer** (independence by session, [operating-model §7.6](operating-model.md); the
  [§9 eh–em](../handoff.md) precedent). Rotate on 429.
- **Warm caches on this host (the vscode harness runs network-free):** the
  `@vscode/test-electron` canonical cache `~/.vscode-test/vscode-linux-x64-1.130.0` (warmed at
  ptv1-3; offline-safe thereafter), Playwright chromium ([handoff §4](../handoff.md)), and the
  vendored engine assets committed under `apps/vscode/assets/duckdb/` (43.07 MB, ptv1-2 — the
  webview opens datasets with zero network fetches).
- **`DUCKDB=/tmp/duckdb`** is needed for the 1M-row/grid-virtualization e2e after a `/tmp` wipe
  ([§9 eo](../handoff.md); [handoff §2 Tests](../handoff.md)).
- **The vscode clean-worktree runbook** is committed at `apps/vscode/README.md` (ptv1-5); drill
  modes: `ASSAY_SPIKE_DRILL=missing-extension` (PASS, exit 0) and
  `ASSAY_SPIKE_DRILL=eh-boot-failure` (FAIL naming `bundles.eh.ok`, exit 1).
- **`corepack pnpm`** if `pnpm` is not on PATH ([handoff §4](../handoff.md)).
- **Flake watch:** the host-load class (5s-timeout under load; `row-diff-agreement`,
  `contracts/round-trip` incl. its fuzz property, `validation/re2`,
  `validation/duckdb-agreement`, `ux.integration.test` — the CLI spawn-integration suites time
  out under load too; one unreproduced full-suite first-run failure at the p3-5 close, green ×2
  full runs + 4 reviewer re-runs — stays on watch, [P3 queue §4](20261002-p3-queue.md)) + the
  **open-status e2e jitter class** ([handoff §4](../handoff.md)) — re-run in isolation, note,
  escalate only on pattern; generous explicit timeouts for e2e rows.

## 6. Pointers

- **Closed queue files (records):** [20261002-p3-queue.md](20261002-p3-queue.md) ·
  [20261002-ptv-slice1-queue.md](20261002-ptv-slice1-queue.md) — the §5 closures are the
  authoritative per-row outcomes + the slice-2 candidate list.
- **The pickup pack:** [20261011-p3-ptv-pickup.md](20261011-p3-ptv-pickup.md) — historical for
  dispatch (its rows all landed); its §6 standing flags are carried in this file's §5.
- **The rulings file:** [20260926-maintainer-rulings.md](20260926-maintainer-rulings.md) —
  D17/D18/D19 (with C-pt0-1, D12–D16) — binding on any slice-2 authoring.
- **ADRs:** [0046](../../adr/0046-dcr-artifact-format-v1.md) (DCR artifact format v1, accepted) ·
  [0012](../../adr/0012-edit-overlay-and-transaction-semantics.md) (edit overlay + transaction
  semantics) · [0022](../../adr/0022-headless-grid-and-renderer-strategy.md) (headless grid,
  replaceable rendering).
- **[product/04](../../product/04-post-mvp-track.md)** — the post-MVP track map: §3 (track
  structure, the PT-V row, and where slice 2 fits = the track exit via MVP scenario 11) and §7
  (the PT-Q residue table).
