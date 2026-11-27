# Collector live, CI tail, and the remaining queue (2026-11-27)

**Base:** `main` at `c5bf32a` (public repo `minghao51/assay`). **Read first:** [handoff §0](../handoff.md),
[2026-11-22 remaining-work handoffs](20261122-remaining-work-handoffs.md) §0, then this file. Everything
below was verified this session unless it says otherwise.

## 1. What changed materially today

**The repository is public.** That removed the Actions billing block outright — public repos get free
standard-runner minutes — so **R-20 is resolved by consequence, not by payment**, and remote CI is a live
signal again (the collector workflow's validate job ran 12 real steps). Consequences:
[AUDIT] the pre-public audit found no secrets in history (only `.env.example`, placeholders), AGPL-3.0
in place (ADR 0036), ~30 MB. **[OPEN RISK] R-17 trademark clearance is still unstarted and the name is
now published.** Nothing else about visibility is unresolved.

**The telemetry collector is deployed and verified.** Site `assay-dataworkbench`; endpoint
`https://assay-dataworkbench.netlify.app/.netlify/functions/collect`. Probed live, not inferred:
`OPTIONS` 204 · `GET` 405 · `text/plain` 415 · over-cap body 413 · **valid batch 202 twice
(warm-stable)** · top-level extra field → `400 invalid-event/unknown-field` with nothing echoed · bad
token grammar → `400 invalid-token` · unknown event → `400 unknown-event`. ADR 0053 (amended) records
the host; the ingest token is checked when `ASSAY_TELEMETRY_INGEST_TOKEN` is set and is honestly a
**spam filter, not authentication**.

**Two deploy hazards were found and fixed, both "green but broken" shaped:**

1. `netlify-cli` does monorepo project detection **before** honouring `NETLIFY_SITE_ID`, so a
   pnpm-workspace root aborts with `Projects detected: …`. Fix: `netlify/netlify.toml` with
   `base = "netlify"` (load-bearing — without it `publish` resolves to `<repo>/publish`), the workflow
   running with `working-directory: netlify`, and the root toml kept for the Git-integration path.
2. Netlify **v2** functions force the `nft` tracer (`node_bundler = "esbuild"` is silently ignored),
   which externalises `@assay/telemetry` and ships only its `package.json` — whose `exports` points at
   `src/index.ts`. A green deploy would have served **502**s. Fix: pre-bundle with
   `scripts/build-collector.mjs` (`pnpm collector:build`) into a self-contained
   `netlify/dist/collect.mjs` (13.3 KiB, validator compiled in — never copied), proved by importing it
   with no `node_modules` reachable. **Keep this**: a future function import of a workspace package
   reintroduces the same trap.

## 2. What is NOT finished — do this first

### 2.1 The workflow reports failure after a successful deploy (one bug — **fixed 2026-11-27**, cause corrected)

Run **`45992312947`**: validate **success**; deploy job **failure** — but the deploy itself succeeded
(`"deploy_id": "6b096c5af962b72365863a5a"`, `"url": "https://assay-dataworkbench.netlify.app"` in the
log). The failing step is the workflow's own URL parse, which emits
`::error title=Collector deploy URL unknown::the CLI printed no site URL; the probe step cannot run.`

**The cause was the SHAPE, not the key.** `url` _is_ a flat top-level key. `netlify deploy --json` prints
**pretty-printed multi-line** JSON, and the step extracted the payload with `grep -a '^{' | tail -n 1`,
which only matches compact one-line JSON — so it captured the lone opening brace, `jq` refused it, and
the step failed after a deploy that had worked. Fixed by `scripts/netlify-deploy-url.mjs` (a balanced,
string-aware JSON-object reader; tested against this run's exact log shape in
`scripts/netlify-deploy-url.test.mjs`) plus split stdout/stderr, which also makes the deploy's own exit
status real instead of `tee`'s. **Acceptance is the probe step passing**, and the probe itself was broken
— see §2.4.

### 2.2 Two further defects found while fixing 2.1 — one is a live outage

**`--probe` never dialled the URL it was given.** `defineProbes` addressed every request to a hardcoded
`https://collector.example.invalid/…` and `probeLive` handed `fetch` straight through, so the operator's
URL was only printed. Consequence: the acceptance tool reported **8/8 `fetch failed` against any
endpoint**, healthy or not, and had never verified a live deployment since it was written. Fixed (the
endpoint is a required parameter; `guardTarget` refuses a mismatched target by name) and pinned by
`scripts/build-collector.test.mjs`. Verified both ways on 2026-11-27: **8/8 green** against the deploy
that received the bundle; `expected 202, got 404` against production.

**Production serves no function (404 on `GET`/`OPTIONS`/`POST`).** The bundle is fine — the deploy
`6b096c5a…` from 11:41Z answers the whole contract on its own URL. But the site is connected to the
repository through Netlify's **Git integration**, its build settings declare **no command**, and
`netlify/dist/` is git-ignored, so each push to `main` publishes the placeholder `publish` directory
with an **empty functions directory** and replaces the workflow's deploy. Measured from the public site
API + HTTP on 2026-11-27:

| Deploy                              | Origin              | Built from | Function on `/.netlify/functions/collect` |
| ----------------------------------- | ------------------- | ---------- | ----------------------------------------- |
| `6b096c5a…` (11:41Z)                | workflow CLI upload | —          | **405/202 — 8/8 contract probes green**   |
| `6b09795d…` (12:36Z)                | Git build           | `fb0dfe7`  | 404                                       |
| `6b097d60…` (12:53Z, **published**) | Git build           | `3bbf12c`  | 404                                       |

So the handoff's "deployed and verified live" was true of the CLI deploy for 72 minutes and was undone by
the next push. **Open decision (maintainer):** (a) give the Git build a command that produces `dist` and
fails when it is empty — `netlify.toml` already says a Git build "must fail rather than deploy an empty
functions directory" — or (b) disconnect the Git integration for this site so only the workflow deploys;
and (c) whether the workflow should verify the canonical URL on **every** push to `main` (a separate job),
not only when it deploys, since Git builds can change production whenever it does not.

### 2.3 Three docs described the old state (**corrected 2026-11-27**)

`docs/engineering/07-telemetry-collector.md` §5 (its artefact table still said
`netlify/functions/collect.ts` is deployed — it is `netlify/dist/collect.mjs`), the successor queue
§15.2 ("unexercised"), and the workflow header comment. All three now state what §2.1–§2.2 measured:
shipped and probe-proven, but **not currently served from the canonical URL**, plus the v2/nft and
`base = "netlify"` constraints.

### 2.4 Usability pass + screenshots on the **hosted** app — not possible yet, and here is why

The Netlify project serves **only the collector**; its `publish` is `netlify/publish`, a checked-in
placeholder — **the web app is not hosted anywhere**. So "explore the hosted app" needs one decision
first: either add the app to this project (a real deploy pipeline for `apps/web/dist`, which then shares
a site with the function and makes `ASSAY_TELEMETRY_ENDPOINT` same-origin) or keep the collector site
single-purpose and host the app separately. Recommendation: **one site, two purposes** — the app at
`/`, the function at `/.netlify/functions/collect` — because same-origin removes the CORS variable
entirely and keeps the disclosure/endpoint pairing in one place.

Until that decision, take the evidence **locally**, which is honest and cheap:

```bash
pnpm build && (cd apps/web && pnpm exec vite preview --port 4373 &)
# then, at 1024x700 / 1440x900 / 1920x1080, capture:
#   idle · a fixture opened (grid + schema) · profile · validation (failing contract)
#   · diff (staged comparison) · SQL (long statement + wide result) · Record inspector
#   · pipeline panel · a both-schemes pair for contrast
# and record for each: console errors, layout overflow, footer/label legibility,
#   and anything that needs scrolling twice to reach.
```

**No usability claim may be written from screenshots** (D-02 A / RD-T07): they are evidence for our own
decisions, and "validated/intuitive/easier" stays forbidden until R-21 runs.

## 3. The remaining queue (of the 22 briefed items)

**Closed this session:** R-1, R-2, R-3, R-6, R-8, R-9 (probe + accepted ADR 0052 + shipped op), R-10,
R-12, R-13. **Measured, nothing adopted:** R-11 (five E02 candidates — now crossed by production _and_
test-only bytes; needs an owner, see its record §7 and successor queue §13). **Contract only:** R-5
(probe proved Arrow types exist for computed/aliased columns — parity is reachable, nothing
implemented), R-7 (item 3 escalated: does it widen the `DataEngine` target?). **Selected, not
commissioned:** R-4 (WFD-04 = A commissions the WF-08 study; no runtime authority). **Withdrawn:**
R-22 (no Node 22 consumer by construction).

| Remaining                         | What it needs                                                                                                                                                                                                                                                                                                                                        | Who                          |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| **R-14** bounded replacement wait | Four product selections: which waits are bounded, the deadline, the unavailable state + copy, recovery semantics. The cancel op now exists, so "op shipped" is satisfied.                                                                                                                                                                            | You decide, then a dispatch  |
| **R-4** WF-08 study               | Commission it: both schemes × 1024×700/1440×900/1920×1080 + 900px fallback + 200% zoom, fixed synthetic cases. Ships nothing.                                                                                                                                                                                                                        | A dispatch, once you want it |
| **R-7** overlay profile           | Item 3 needs an architect ruling (does it cross package boundaries?). Contract is drafted.                                                                                                                                                                                                                                                           | You/architect                |
| **R-5** temporal parity           | Nothing blocking; a dispatch per the contract.                                                                                                                                                                                                                                                                                                       | A dispatch                   |
| **R-11** budgets                  | Adopt/reject the five candidates; decide whether `webview-script` carries test-only bytes.                                                                                                                                                                                                                                                           | You                          |
| **R-16** npm `@assay` scope       | Create the org, 2FA. Then R-15's publish gate (green gates + changeset) is the only bar.                                                                                                                                                                                                                                                             | You (credentials)            |
| **R-17** trademark/domain         | Legal clearance; **now more urgent** because the repo is public.                                                                                                                                                                                                                                                                                     | You (legal)                  |
| **R-19** demo dataset             | Ruling taken: **generate it, do not source it** (successor queue §15.4). Generate the seeded fixture set.                                                                                                                                                                                                                                            | A dispatch                   |
| **R-21** RD-T07 study             | Recruit and run sessions; protocol + fixtures can be prepared.                                                                                                                                                                                                                                                                                       | You (people)                 |
| **R-18** collector hosting        | **Deployed, but production serves no function.** Workflow upload verified 8/8 live; superseded by Git-integration builds of `main` that ship no function (§2.4). Two decisions: Git-build command **or** disconnect the Git integration; and whether to probe the canonical URL on every push. Then set `ASSAY_TELEMETRY_ENDPOINT` on the app build. | You decide, then config      |
| **R-15** publication              | Gate is our own green gates (successor queue §15.3); the policy document is dropped as over-engineering.                                                                                                                                                                                                                                             | After R-16                   |
| **R-20** Actions billing          | **Resolved by the repo going public.** Keep an eye on spending if private runners are ever used.                                                                                                                                                                                                                                                     | —                            |

**Still unwritten, both real:** `dependency-report --check` cannot see engine-string drift (how 12
workspaces kept claiming `>=22` through C4); and `packages/engine-duckdb/dist` (+19k B) is in no
measured payload because the package is private.

## 4. Environment facts a new thread will need

- `export DUCKDB=/tmp/duckdb PATH=/tmp:$PATH` — **verify `/tmp/duckdb --version` first**. If it is
  missing, 76 real-CLI agreement tests turn into _skips_ and `pnpm test` still reports success. Read the
  **skipped** count, not just failures. Restore with
  `https://github.com/duckdb/duckdb/releases/download/v1.5.5/duckdb_cli-linux-amd64.zip`.
- Full suite after everything above merged: **298 files / 4704 tests, zero skipped**, lint, typecheck
  20/20, format, docs links 204/0, ADR index 53, current-state 107 assertions, dependency report
  116 entries.
- Two suites are contention-flaky and pass solo: `packages/engine-duckdb/src/row-diff-agreement.test.ts`
  and `apps/web/src/sql/SqlPanel.telemetry.test.tsx`. Re-run solo; never raise a ceiling.
- A **stale `apps/web/dist`** produces false e2e reds (the uxv-2 cache-restore trap): always
  `rm -rf apps/web/dist` before an e2e run. It cost one review round today.
- Deploy secrets are set (`NETLIFY_AUTH_TOKEN`, `NETLIFY_SITE_ID`); the app build needs
  `ASSAY_TELEMETRY_ENDPOINT`, and the site optionally `ASSAY_TELEMETRY_INGEST_TOKEN` /
  `ASSAY_TELEMETRY_ALLOWED_ORIGINS`. `.env.example` documents all of it by where it is set.
