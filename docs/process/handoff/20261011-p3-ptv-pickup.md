# Historical Pickup Pack — P3 Close-out + PT-V Slice 1

> **HISTORICAL — DO NOT DISPATCH.** All implementation rows below landed and
> both queues closed 2026-10-11. Read [the living handoff](../handoff.md) for
> active work. Old prompts/counts are preserved as evidence, not current
> instructions; closure records override every "open" or "NEXT" below.

**Reference pack — authored 2026-10-11 by the orchestrator session that landed p3-1…p3-3
(2026-10-02 → 2026-10-10); for a NEW thread picking up the serialized lane.** This file is
reference text, not a second authority: the prompts below are dispatch-ready copies — the
**queue rows remain the authoritative scope/done-when/STOP** (§0 item 2). Paperwork (row flips,
§6 sync, §9 changelog letter, phase-doc 07 status) stays orchestrator-owned; workers never touch
`docs/**`.

## §0 How to pick up

1. Read [`handoff.md`](../handoff.md) **§6 (Active)** → this file.
2. Read the two queue files — the [P3 queue](20261002-p3-queue.md) and the [PT-V slice-1 queue](20261002-ptv-slice1-queue.md) — **their row cells remain the authoritative scope/done-when/STOP; if a prompt below and a queue row ever disagree, the row wins.**
3. Read [AGENTS.md](../../../AGENTS.md) + [`operating-model.md`](operating-model.md) §7 (worker → independent reviewer → orchestrator-integrate; ONE row per dispatch; serialized lane, P3 first).

Protocol per cycle: dispatch the worker (prompt below) → fresh-session reviewer (skeleton below)
→ paperwork (row flip, §6 sync, §9 next letter, phase-doc 07 status) → next row. Workers archive
briefs to `/tmp/<row>-worker-brief.md` on first action (§7.4: dispatch briefs live in `/tmp`;
this pack is reference text).

## §1 State at authoring (2026-10-11)

- `main` = `9e3fda3`, tree clean, changesets **145**, unit **2842**/176 files, coverage 89.55/83.69/89.97/91.14, docs:links 102/0, all gates green (verified through the p3-3 review).
- **P3 queue (4/6 done):** p3-1 `dae8e83` ✅ · p3-2 `72363b7` ✅ · p3-1b `2b9a895` ✅ (D19-OQ-4 bounding disclosure) · p3-3 `a97379e` ✅ (`assay dcr`; golden at `fixtures/dcr/cli-gated-run.yaml`; deltas = schema-drift-only, ruled-legal absence) · **p3-4 open (next)** · p3-5 open (closes queue).
- **PT-V slice 1 (0/5):** ptv1-1…ptv1-5 all not started; second on the shared lane.
- **D19 recorded** ([rulings file](20260926-maintainer-rulings.md) + roadmap §7 + [phase doc 07 §9](../../product/07-p3-dcr-integration.md)) — OQ-1 enum-closure + optional-keys-additive + digest-over-full-canonical-form (confirmed); OQ-4 landed; OQ-5 liveness (export refuses loudly, parse tolerant); OQ-6(b) fingerprint fixture → p3-5; OQ-3 byte-stability = fixture-corpus policy; OQ-7 snapshot semantics.
- **Roster flag:** pinned Go lanes (`worker` deepseek-v4.1-flash / `reviewer` mimo-v2.6-pro) returned 429 GoUsageLimitError on every probe 2026-10-10; all cycles ran on the rotated scout roster (scout-as-worker, fresh scout session as reviewer — independence by session, §7.6 + §9 eh–em precedent). **Each new session: probe the pinned lanes once first (cheap), rotate on 429.**

## §2 Prompts — P3 close-out

One block per dispatch, in order (p3-4 first; p3-5 only after p3-4's paperwork lands). Each prompt
quotes its queue row verbatim for dispatch convenience — the [queue file](20261002-p3-queue.md)
remains authoritative (§0 item 2).

### p3-4 — web panel export off a gated run (dispatch NEXT — an e2e row)

```
ROLE ROTATION NOTICE: WORKER role under operating-model §7.6 (pinned Go lane exhausted — rotated roster per handoff §9 eh–em; probe pinned lanes once first, rotate on 429). You IMPLEMENT task p3-4 — code, tests, e2e, gates, commit.

One task: p3-4 from docs/process/handoff/20261002-p3-queue.md. Single serialized lane; work on `main` (clean tree at dispatch); no worktrees/branches.
FIRST ACTION: archive this brief verbatim to /tmp/p3-4-worker-brief.md, then execute.

TASK ROW (verbatim, incl. D19 amendment):
> p3-4 — `apps/web/src/pipeline/**` (+ the shared builder). Export action on completed/gated runs delivering a new sanitized file (the m5-3/m6-4 export discipline: `diff-export.ts`/`report-export.ts`); a11y + keyboard parity with the panel (the p2-6 patterns); value-free. Done-when: a web export e2e (playwright, existing panel style) asserting delivery + a value-free content pin; dual-scheme axe clean; LOAD-BEARING PIN: web≡CLI byte-agreement — the same golden gated run exports byte-identical artifact bytes from CLI and web (the M5/M6 exact-agreement precedent). `feat(p3-4):` + changeset (`@assay/web`). **Fourth.**
> **D19 OQ-5:** same export-time liveness refusal on the web path.

READ FIRST: AGENTS.md; docs/product/07-p3-dcr-integration.md §6 + §5's landed note (byte-agreement targets `fixtures/dcr/cli-gated-run.yaml`'s builder path — the same `fixtures/pipeline/cli_dcr_gated.yaml` golden run); the CLI implementation `apps/cli/src/{dcr,report-dcr}.ts` (the seam you mirror); `apps/web/src/**` export precedents (`diff-export.ts`, `report-export.ts`, m5-3/m6-4 discipline) + p2-6 a11y patterns; ADR 0025; queue §2–§4.

CONSTRAINTS (binding):
- LOAD-BEARING: web-exported bytes ≡ CLI committed golden bytes for the same golden gated run (byte-for-byte pin; the M5/M6 precedent). One shared builder — no web-side re-serialization.
- OQ-5: export refuses loudly on dangling materialization refs (typed error, surfaced in-panel per existing refusal UX); nothing written on refusal; parse stays tolerant.
- New sanitized file only (ADR 0012); m5-3/m6-4 sanitization + delivery discipline (no innerHTML/script from content).
- a11y + keyboard parity per p2-6 patterns; dual-scheme axe clean (both color schemes).
- Value-free content pin in the e2e (assert delivery + no dataset values in bytes).
- E2E: playwright, existing panel test style. `pnpm build` FIRST; chromium via `pnpm exec playwright install chromium` (once). Local e2e jitter is known: generous explicit timeouts; isolation re-run if random tests drop; escalate only on pattern. Default ports (single lane).
- Consume `packages/**` only — zero changes there; if one seems needed, STOP and report.

SCOPE: `apps/web/src/pipeline/**` (+ panel wiring where the existing pattern requires), web test/e2e files, `.changeset/**` (one file, `@assay/web`). FORBIDDEN: docs/**, apps/cli/**, packages/**, root configs.
GATES: the seven + e2e (web-visible row): format:check / lint / typecheck / test / test:coverage / build / docs:links:check / test:e2e. Baseline at dispatch: 2842/176, coverage 89.55/83.69/89.97/91.14, changesets 145 — account for every delta.
HYGIENE: no `any` w/o comment; strict TS; one Conventional Commit `feat(p3-4):` + one changeset; tree clean.
BLOCK: >15 min unresolvable (STOP boundaries, packages/ need) → halt, report BLOCKED + exact question.
REPORT: DONE|BLOCKED; commit hash+message; files; how byte-agreement/liveness/a11y/value-free are each pinned; gate tails + counts with deltas (incl. e2e count); deviations + rationale.
```

### p3-5 — conformance + honesty bundle (LAST — closes the queue)

```
ROLE ROTATION NOTICE: WORKER role under §7.6 (rotated roster; probe pinned lanes once first). You IMPLEMENT task p3-5 — sweep tests, fixes only for exposed defects, commit.

One task: p3-5 from docs/process/handoff/20261002-p3-queue.md. Single serialized lane; work on `main` (clean tree). FIRST ACTION: archive to /tmp/p3-5-worker-brief.md.

TASK ROW (verbatim, incl. D19 amendment):
> p3-5 — `packages/pipeline/**`, `apps/cli/**`, `apps/web/**` (test-only + small discovered fixes). Round-trip sweep (every committed fixture parse→serialize→byte-identical; corrupt variants → located errors, never throws); an additive-only guard test (unknown keys → version-stamped rejection, per Q12); a reserved-namespace sweep; fixes only for sweep-exposed defects (each with a fixture + regression test per AGENTS.md). Done-when: sweep green; no new features smuggled in. `test(p3-5):`/`fix(p3-5):` + changeset only if packages changed. **Last — closes the queue.**
> **D19 OQ-6(b):** fingerprint-stability fixture (schema set → expected fingerprints) joins the sweep.

READ FIRST: AGENTS.md; docs/product/07-p3-dcr-integration.md §7; queue §2–§4; the full `fixtures/dcr/` corpus (p3-1's 16 + p3-1b's 3 + p3-3's `cli-gated-run.yaml`); `dcr-parse/serialize/validate` + the p3-2 `candidateVersionRefFromRun` fingerprint path.

CONSTRAINTS: sweep = every committed DCR fixture parse→serialize→byte-identical (incl. the CLI golden — proves the corpus end-to-end); corrupt/mutated variants → located typed errors, never throws (extend the fuzz/corrupt discipline); additive-only guard per D19-OQ-1 semantics (unknown keys → version-stamped rejection; enum closure pinned); namespace sweep (`assay_dcr_*` case-insensitive, id positions); fingerprint-stability fixture per D19-OQ-6(b) (schema set → pinned `assay-schema-fingerprint-v1` outputs). Fixes ONLY for defects the sweep exposes — each fix ships fixture + regression test; NO features, NO grammar changes (any perceived format need = STOP per Q12). Value-free everywhere (ADR 0025).
SCOPE: test files + minimal fixes within `packages/pipeline/**`, `apps/cli/**`, `apps/web/**`; fixtures under `fixtures/dcr/**` if a fix demands one; changeset only if packages changed.
GATES: the seven (no e2e — not web-visible). Baseline at dispatch refreshed by orchestrator. HYGIENE/BLOCK/REPORT: as p3-4 template (`test(p3-5):`/`fix(p3-5):` commit).
```

## §3 Prompts — PT-V slice 1

Second on the shared serialized lane — PT-V rows run after P3 closes (or per the interleave rule:
an `apps/vscode/**`-only row may interleave if P3's in-flight row does not touch
`packages/engine-duckdb`). One block per dispatch, in order:

### ptv1-1 — engine webview adapter (bundler-agnostic worker seam)

```
ROLE ROTATION NOTICE: WORKER role under §7.6 (rotated roster; probe pinned lanes once first). One task: ptv1-1 from docs/process/handoff/20261002-ptv-slice1-queue.md. Serialized lane; work on `main`; archive to /tmp/ptv1-1-worker-brief.md.
ROW (verbatim): `packages/engine-duckdb/**` + `apps/vscode/**`. Today the client hard-codes `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })` (`src/client.ts:308-311`; also `src/index.ts:287-290`; the inner DuckDB worker `src/worker.ts:86`). Add an injectable worker-factory + asset-URL seam so a host supplies blob-URL bootstrapping (the spike-proven `toBlobUrl` in `apps/vscode/webview/main.ts`) and the measured CSP (the spike's `buildHtml`). Worker entries: esbuild for the extension, Vite for web — one shared worker core. Done-when: the seam lands with default web behavior byte-identical (existing tests green, no Vite regression); headless unit pins for the injection logic (the `engine-target-compat.test.ts` patterns); the spike harness boots the real adapter, not spike-local code. `feat(ptv1-1):` + changeset (`@assay/engine-duckdb`, `@assay/vscode`). **First.**
READ FIRST: AGENTS.md; the PT-V queue whole (63 lines); D18 ruling (rulings file); R4 spike report docs/engineering/08-vscode-webview-feasibility.md (§8/§10 mandatory items); apps/vscode/webview/main.ts; engine-duckdb client/worker seams cited above.
CONSTRAINTS: default (web) behavior BYTE-IDENTICAL — the web app's gates are the proof (STOP boundary: any engine change altering web-app behavior); one shared worker core, two entries (esbuild extension / Vite web); the harness must boot the REAL adapter. STOP: vscode-web anything; production features beyond the row; boundary crossings.
SCOPE: `packages/engine-duckdb/**`, `apps/vscode/**`, `.changeset/**` (both packages as touched). GATES: the seven (e2e NOT required for PT-V rows — verification is the committed harness). HYGIENE/BLOCK/REPORT: as p3-4 template; `feat(ptv1-1):`.
```

### ptv1-2 — vendored engine assets (local-first)

```
ROLE ROTATION NOTICE: WORKER role under §7.6 (rotated roster; probe pinned lanes once first). One task: ptv1-2 from docs/process/handoff/20261002-ptv-slice1-queue.md. Serialized lane; work on `main`; archive to /tmp/ptv1-2-worker-brief.md.
ROW (verbatim): `apps/vscode/**`. Vendor `duckdb-mvp.wasm` + `duckdb-browser-mvp.worker.js` + the Parquet extension; the webview opens datasets with ZERO network fetches. Done-when: the harness runs network-blocked (assert no request to `extensions.duckdb.org` — pin the spike's Q5b failure mode as fixed); the extension-version pin documented; a package-size report (~40 MB) in harness output; a license note (DuckDB-WASM MIT — AGPL-compatible per AGENTS.md). `feat(ptv1-2):` + changeset (`@assay/vscode`). **Second.**
CONSTRAINTS: zero network fetches pinned (network-blocked harness run; the extensions.duckdb.org refusal is THE pin — the spike's Q5b failure mode, now fixed); version pin documented in-repo; size report in harness output; MIT/AGPL license note (AGENTS.md license rule). SCOPE: `apps/vscode/**` only. GATES: the seven. HYGIENE/BLOCK/REPORT: as p3-4 template; `feat(ptv1-2):`.
```

### ptv1-3 — extension host + workspace adapter

```
ROLE ROTATION NOTICE: WORKER role under §7.6 (rotated roster; probe pinned lanes once first). One task: ptv1-3 from docs/process/handoff/20261002-ptv-slice1-queue.md. Serialized lane; work on `main`; archive to /tmp/ptv1-3-worker-brief.md.
ROW (verbatim): `apps/vscode/**`. Production-shape (no longer spike-only): activation, command/custom-editor surface for supported formats, `showOpenDialog` + `workspace.fs.readFile` → webview bytes bridge, error/empty-file handling. Done-when: real VS Code (`@vscode/test-electron`) opens a workspace file end-to-end; typed error paths (missing file, unsupported format) surface in the webview; no `innerHTML` violations; no telemetry. `feat(ptv1-3):` + changeset (`@assay/vscode`). **Third.**
CONSTRAINTS: `@vscode/test-electron` download is flaky offline — cache once (queue §4); no innerHTML (security hard rule); no telemetry (ADR 0025/0037 — none exists, keep it none); typed error paths surfaced in-webview. SCOPE: `apps/vscode/**` only. GATES: the seven. HYGIENE/BLOCK/REPORT: as p3-4 template; `feat(ptv1-3):`.
```

### ptv1-4 — webview dataset surface on the headless grid

```
ROLE ROTATION NOTICE: WORKER role under §7.6 (rotated roster; probe pinned lanes once first). One task: ptv1-4 from docs/process/handoff/20261002-ptv-slice1-queue.md. Serialized lane; work on `main`; archive to /tmp/ptv1-4-worker-brief.md.
ROW (verbatim): `apps/vscode/**` (reusing the `packages/grid` headless API — `GridViewportModel` + contracts are DOM-free — and `packages/domain`; ADR 0008/0022). Minimal open→inspect: file opens → grid renders (virtualized viewport) → sort/filter-lite per the grid contracts. OUT OF SLICE 1 (recorded explicitly): edit/validate/diff in VS Code (MVP scenario 11 = the track exit, later slices), Git context, the dataset diff command, settings/UI polish. Done-when: a 1M-row synthetic fixture opens → first row visible < 1 s (picker→first-row envelope) and live heap within the spike-measured budget in the harness; keyboard/a11y basics consistent with the web app's standards; a11y checks to the extent harness-testable. `feat(ptv1-4):` + changeset (`@assay/vscode`). **Fourth.**
CONSTRAINTS: consume grid/domain — no edits to them (STOP if one seems needed); the OUT-OF-SLICE list is a STOP boundary; performance envelope = 1M-row synthetic, TTFR < 1 s picker→first-row, live heap within spike budget (1.14 MB measured — harness asserts); synthetic fixtures only (ADR 0025). SCOPE: `apps/vscode/**` only. GATES: the seven. HYGIENE/BLOCK/REPORT: as p3-4 template; `feat(ptv1-4):`.
```

### ptv1-5 — evidence harness + carry-list hardening (LAST — closes the slice)

```
ROLE ROTATION NOTICE: WORKER role under §7.6 (rotated roster; probe pinned lanes once first). One task: ptv1-5 from docs/process/handoff/20261002-ptv-slice1-queue.md. Serialized lane; work on `main`; archive to /tmp/ptv1-5-worker-brief.md.
ROW (verbatim): `apps/vscode/**`. Upgrade `run:spike` into the slice-1 exit harness: the pass/fail assertion extended with the ptv1-1…ptv1-4 headline claims; R1 FIXED — an `eh`-only boot failure exits non-zero (the ptv-1 review carry-over); R2 timing envelopes re-measured in harness output (report text updated by the orchestrator at integration); offline + memory-budget + boot pins asserted. Done-when: the harness green end-to-end from a clean worktree via committed commands; reviewer-reproducible (the ptv-1 precedent); no production features beyond the ptv1-3/ptv1-4 scope. `test(ptv1-5):`/`chore(ptv1-5):` + changeset (`@assay/vscode`). **Last — closes the slice.**
CONSTRAINTS: harness asserts the ptv1-1…4 headline claims (byte-identical web default, zero-network, e2e open, TTFR/heap envelopes); R1 = eh-only boot failure must exit non-zero (the carry-over fix); R2 timings re-measured (report prose is ORCHESTRATOR-owned — worker outputs numbers, doesn't edit docs); reviewer-reproducibility from a clean worktree via committed commands is the acceptance bar. SCOPE: `apps/vscode/**` only. GATES: the seven. HYGIENE/BLOCK/REPORT: as p3-4 template; `test(ptv1-5):`/`chore(ptv1-5):`.
```

## §4 Reviewer skeleton (per cycle)

Fresh session every cycle (independence by session, §7.6). Fill the `<…>` placeholders per row;
the drill list in checklist item D names each row's load-bearing claims — run ≥1 drill per
claim, prove it bites, revert, leave the tree clean.

```
ROLE ROTATION NOTICE: independent adversarial REVIEWER under §7.6 (fresh session, rotated roster). Requirements over implementation; bash = verification only (gates + mutation drills); never fix/commit; revert every mutation; tree clean start/end. Trust nothing; re-derive.
Commit under review: <hash> (parent <parent>). WORKER CLAIMS TO SCRUTINIZE: <paste worker report>.
CHECKLIST: A gates re-run (re-derive counts + changeset count) [+ e2e for p3-4 only]; B scope grep (`git show --stat`) vs the row's allowed globs; C ruling conformance (<row's rulings: D17-Q*/D19-OQ* for P3 rows; D18 + spike facts for PT-V rows>); D mutation drills — ≥1 per load-bearing claim, each must fail a pin, then revert (drills: <row-specific: byte-agreement/liveness for p3-4; sweep-corpus/guard-bite for p3-5; web-byte-identical for ptv1-1; network-block for ptv1-2; error-path surfacing for ptv1-3; TTFR/heap envelope for ptv1-4; R1 non-zero-exit for ptv1-5>); E failing-before-fix evidence re-derived; F deviations judged vs row + rulings; G queue done-when mapped + STOP boundaries verified; H hygiene (no `any`, one commit, one changeset, clean tree, brief matches dispatch).
CONTEXT: baseline <counts>; flake-watch list (+ @vscode/test-electron cache for PT-V). VERDICT: end with EXACTLY one line: `VERDICT: approve` or `VERDICT: request-changes` + numbered actionable items.
```

## §5 After the queues close

- P3 closure per the [queue §5](20261002-p3-queue.md): per-row outcomes table, counts at close, the G3 evidence note "DCR artifact format stable (M9 done)" ([roadmap §5](../../product/03-execution-roadmap.md)), re-point handoff §6 closed table + roadmap §4 + [product/04](../../product/04-post-mvp-track.md). PT-V closure per [its §5](20261002-ptv-slice1-queue.md): slice-2 candidate list + the vscode-web re-scope spike note (`@vscode/test-web` follow-up).
- §9 changelog letters: latest is (em) → next (en), then (eo)…
- R2 timing-report prose in ptv1-5 is orchestrator-owned — worker outputs numbers, paperwork writes them.

## §6 Standing flags

- **Privacy:** [ADR 0025](../../adr/0025-telemetry-and-data-privacy-boundary.md) value-free everywhere.
- **Publish boundary stays refused** ([ADR 0033](../../adr/0033-materialization-is-logical-and-backend-mapped.md) / [ADR 0035](../../adr/0035-data-quality-and-publish-gates-are-first-class-dag-nodes.md)).
- **D19-OQ-1:** no enum additions — version bump instead.
- **Local e2e jitter** (handoff §4): p3-4 is the one e2e row — generous explicit timeouts, isolation re-run, escalate on pattern only.
- **`@vscode/test-electron`** download is flaky offline — cache once (PT-V rows).
- **`corepack pnpm`** if `pnpm` is not on PATH (handoff §4).
- **Dispatch briefs live in `/tmp`** (`/tmp/<row>-worker-brief.md`); this pack is reference text.
