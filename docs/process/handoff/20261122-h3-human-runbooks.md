# H3 — human runbooks (2026-11-22)

**Date:** 2026-11-22. **Base:** `main` at `6b2c9fd`. **Status:** runbooks for the items that cannot be
done from the repository alone — accounts, registry, legal, hosting, billing and human participants.
Nothing here is executed, authorised or paid for by writing it down; each item names the human who
must act. This is the H3 lane of the
[remaining-work index](20261122-remaining-work-handoffs.md) (R-15 … R-22); its §0 verification
protocol and §2 dispatch envelope apply, and the authority order is the index's.

Facts are marked **verified** (command output or `path:line` read at the base SHA) or **assumed**.
Dated snapshots of counts are labelled as such: the changeset ledger is re-counted in R-15 below
because the figures in older records move.

---

### R-15 — publication / registry policy and the first release

**Status:** DECISION + HUMAN ACTION
**Owner:** maintainer (registry policy decision; the publish itself needs the account owner's 2FA)
**Why it blocks:** consumes the pending changeset ledger into the first versioned, installable
release — the D-12 option-C release cut that
[the decision round](20261121-decision-round.md) §3 explicitly did **not** authorise ("**B** for
push, **C** not authorized").
**Facts (verified):**

- **240 pending changesets** at `6b2c9fd` (`ls .changeset/*.md | wc -l` → 240; no `README.md` in
  `.changeset/`). The "229-entry changeset ledger" at
  [decision round](20261121-decision-round.md):75 is a 2026-11-21 figure and is already stale;
  [open-asks](20261019-open-asks.md) says to re-count before a cut rather than trust a dated
  snapshot.
- `pnpm changeset status` at the base: 14 packages to be bumped, all **minor** — `@assay/{cli,
contracts,data-sources,diff,domain,engine,engine-duckdb,grid,pipeline,telemetry,testing,validation,vscode,web}`.
- Every workspace package is at `0.0.0` (all 20 manifests read).
- `.changeset/config.json`: `"access": "restricted"` (line 5),
  `"commit": false` (line 4), `"privatePackages": {"version": true, "tag": false}` (lines 8–11),
  `"baseBranch": "main"` (line 6).
- Private flags (read from the manifests): `private: true` on `apps/web`, `apps/vscode`,
  `packages/{ai,core,data-sources,engine,engine-duckdb,engine-parquet,pipeline,security,testing,transforms,ui}`;
  no `private` field (i.e. publishable today) on `apps/cli` and
  `packages/{contracts,diff,domain,grid,telemetry,validation}`.
- The CLI runtime closure (`apps/cli/package.json:33-43`) is `@assay/{contracts,diff,domain,
engine-duckdb,pipeline,telemetry,validation}` — two of those, `engine-duckdb` and `pipeline`, are
  `private: true`. The [publish runbook](20260926-publish-runbook.md) 2026-10-14 banner: "The private
  runtime dependency closure also needs an explicit registry-distribution decision before an
  independently installable CLI can publish."
- `node apps/cli/scripts/pack-consumer-smoke.mjs` packs the recursively derived closure and runs it
  under plain Node in an isolated npm consumer ([ADR 0042](../../adr/0042-library-builds-tsc-project-references.md));
  it pins plain-Node exports for `@assay/{contracts,grid,diff,domain,pipeline,telemetry,validation}`
  and asserts every closure package has a build script. It is green in the base's recorded evidence
  ([index](20261122-remaining-work-handoffs.md) §0: pack smoke PASS), so the runbook's older "packed
  smoke omits pipeline/telemetry" note is superseded — the registry-distribution decision is not.
- Licences: `"license": "AGPL-3.0-or-later"` in the root and all 20 package manifests (verified);
  root `LICENSE` exists; [ADR 0036](../../adr/0036-agpl-license.md) Accepted. The `files` fields of
  the seven publishable packages whitelist `dist/**` only, so `fixtures/**` cannot ship in a tarball.
- The [publish runbook](20260926-publish-runbook.md) carries a standing warning: "revalidation
  required; do not publish from this historical recipe" — its September dry-run is historical
  evidence only.

**Decision inputs:**

1. **Registry:** public npm vs a private registry. Public npm needs the `@assay` scope first (R-16)
   and, for `--provenance`, a public repository (the repo is private `minghao51/assay`,
   [manual-actions](../manual-actions.md) M2; publish runbook P3). A private registry removes the
   scope-ownership precondition but adds consumer-side `.npmrc` configuration and its own access
   control.
2. **Access level:** `.changeset/config.json` defaults to `"access": "restricted"` — a public release
   must pass `--access public` (as the runbook's step 6 does) or change the config deliberately.
   Do not let the default decide this silently.
3. **Package set:** (a) the seven currently publishable packages; (b) the full CLI runtime closure —
   requires flipping `engine-duckdb` and `pipeline` from `private: true` (they are deliberately
   private today; the runbook records engine-duckdb as "NOT published"); (c) libraries only, holding
   `@assay/cli` back. Publishing `@assay/cli` under (a) leaves `npm i @assay/cli` unresolvable, so
   (a)+CLI is not an option.
4. **Version strategy:** all packages are `0.0.0`; the ledger plans `minor` → `0.1.0` for the 14
   touched packages. Decide the 0.x policy (pre-1.0, breaking changes are minor bumps until `1.0.0`)
   and what milestone earns `1.0.0`. The C4 changeset already records the Node-floor narrowing as
   minor only because nothing is published.
5. **Tag convention:** `v<pkg>@<version>` per package, or one `vYYYY-MM-DD` cut tag — pick **one**
   (runbook step 7). `privatePackages.tag: false` means changesets will not tag private packages at
   all, so tags are whatever the cut step creates explicitly.

**Steps:**

1. Record the base SHA and run the [verification protocol](#verification-protocol) on a clean tree.
   Re-count the ledger: `ls .changeset/*.md | wc -l` and `pnpm changeset status`.
2. Dry-run the cut in a throwaway worktree before committing to it:
   `git worktree add /tmp/assay-release-dryrun main && cd /tmp/assay-release-dryrun && pnpm install
--frozen-lockfile && pnpm changeset version` — inspect, then discard the worktree.
3. **Version:** `pnpm changeset version` (or `pnpm version-packages`) consumes every pending
   changeset, rewrites versions + CHANGELOGs, empties `.changeset/` to config only. Review the diff
   (`git status` + `git diff`): expect package.json version bumps, CHANGELOG.md additions, lockfile
   version-reference refresh, and — per `privatePackages.version: true` — bumps for private packages
   too (that is expected, they are not published).
4. `pnpm install` (lockfile refresh), then one commit: `chore: release — version packages`
   (`commit: false` means changesets does not commit for you).
5. **Full gates on the cut tree:** the verification protocol suite, including
   `node apps/cli/scripts/pack-consumer-smoke.mjs`.
6. **AGPL/licence check:** confirm the diff keeps `AGPL-3.0-or-later` in every manifest to be
   published and that no manifest lost its licence field; `pnpm pack` one package and check the
   tarball carries the LICENSE text (npm includes `LICENSE` automatically) and nothing outside the
   `files` whitelist — especially no fixtures.
7. **Push the cut commit and require remote CI green before the registry** (runbook step 5). While
   Actions is billing-blocked (R-20) the local suite is the documented substitute — record that
   deviation explicitly; do not skip it silently.
8. **Publish:** from a clean tree at the cut commit, `pnpm -r publish --access public --no-git-checks`
   (or the private-registry equivalent with its `--registry`/auth config). pnpm resolves
   `workspace:*` to real versions and skips `private: true` packages; supply the 2FA OTP as prompted.
9. **Tag + release:** create the chosen tag convention and push tags; cut GitHub release notes from
   the generated CHANGELOG sections.
10. **Post-publish verification:** from a scratch directory outside the repo —
    `npm i @assay/cli` (or the chosen package set), then `assay --version` plus one `validate`,
    `diff` and `profile` run against a fixture (byte-stable JSON, empty stderr, house exit codes);
    exercise the `npx` path too. Verify with `npm view @assay/<pkg> version` for each published
    package.
11. **Record:** `pnpm changeset status` must now be clean; tick
    [manual-actions](../manual-actions.md) M1 and the open-asks "First release cut" row with the date
    and tag names; splice the close into [handoff](../handoff.md) §9.

**Verification:** the version diff review (step 3), all gate exits on the cut tree, the pack smoke
PASS, the post-publish scratch-consumer run (step 10) and `npm view` output for every published
package. Record the exact commands and exits.

**Rollback / failure handling:**

- Before step 8: abort freely — revert the cut commit, delete any tags; nothing is public.
- After step 8: npm allows unpublish within 72 h for a broken cut; once anything has consumers,
  prefer `npm deprecate` + a patch cut over unpublish (runbook "Abort / rollback"). For a private
  registry, yank per that registry's rules. Record any incident in
  [handoff](../handoff.md) §9.

**Do not:**

- publish from the September recipe without re-running steps 1–6 (the runbook's own banner forbids
  it);
- publish `apps/web` or `apps/vscode` (both `private: true`; the extension goes to a marketplace,
  not npm), or `fixtures/**` or any real data;
- publish `@assay/cli` while `engine-duckdb`/`pipeline` stay private — the closure decision is
  mandatory;
- let `"access": "restricted"` silently publish restricted packages when public was intended;
- tag via the changesets flow for private packages (`tag: false` means it will not; do not fight it).

**Evidence to record:** the reviewed version diff summary (packages + versions), gate exits, publish
command output, `npm view` results, the tag list, the scratch-consumer smoke output, and the
ledger updates (manual-actions + open-asks + handoff §9).

**Depends on:** R-16 (scope ownership) and R-20 (the "remote CI green on the cut commit"
precondition). R-17 (trademark/domain) is **parallel, not a publish prerequisite** — the publish
runbook's P4 row says the same; the index was corrected to match on 2026-11-22.

---

### R-16 — npm `@assay` scope ownership

**Status:** HUMAN ACTION
**Owner:** maintainer (the npm account owner; no agent may create accounts or hold credentials)
**Why it blocks:** the first publish (R-15) — the `@assay/*` scope must be ours before anything is
published ([manual-actions](../manual-actions.md) M1; [ADR 0039](../../adr/0039-product-name-assay.md)).
**Facts (verified):**

- [ADR 0039](../../adr/0039-product-name-assay.md) (Accepted): workspace scope `@assay/*`, CLI bin
  `assay`. "Registry reality (checked 2026-09-14): the unscoped npm package `assay` exists (v1.0.0,
  unrelated); the `@assay` scope appears unclaimed." — a dated observation; availability today is
  **unknown and must be checked** (no network access from repository work).
- [manual-actions](../manual-actions.md):9 (M1): claim the `assay` org on npm (npmjs.com → orgs →
  `assay`) with the maintainer account, 2FA on; status ⏳ open.
- Publish runbook P2: an npm granular token or a logged-in `pnpm login` with publish rights is
  required alongside the claim.
- `publishConfig` in the publishable packages carries only `exports`/`bin` remapping (verified in
  `apps/cli`, `packages/{contracts,diff,domain,grid,telemetry,validation}`) — no `access`, no
  registry key, no provenance configuration exists today.
- The repo is private (`minghao51/assay` under the maintainer user account,
  [manual-actions](../manual-actions.md) M2), and `--provenance` requires a public repo (publish
  runbook P3).

**Decision inputs:**

1. **Org vs personal scope:** the records assume an npm org named `assay` (M1). Org tiers and prices
   are **not recorded anywhere in this repository — must be checked on npmjs.com** before choosing.
2. **2FA and token posture:** 2FA on for the maintainer account (publish runbook P1); a granular
   access token scoped to `@assay` publish rights (P2) vs a `pnpm login` session — the token is
   safer for scripted runs and must live outside the repository (engineering/04 security principles:
   secrets never in portable workspace files).
3. **Provenance timing:** enable `--provenance` only after the repo is public (P3 / the G0 public
   flip) — decide whether the first release ships without it and records that fact, or waits.

**Steps:**

1. **Naming check (must be checked):** `npm view @assay/cli`, `npm view @assay/domain` (expect E404
   for every `@assay/*` name) and `npm view assay version` (expect `1.0.0`, the unrelated unscoped
   package). On npmjs.com, confirm the `assay` scope/org is unclaimed. Any existing `@assay/*`
   package or org is a STOP (see below).
2. npmjs.com → create/claim the `assay` org with the maintainer account; enable 2FA on the account.
3. Create a granular access token with publish rights limited to the `@assay` org; store it in a
   password manager or the CI secret store — never in the repo. Verify with `npm whoami`.
4. Decide provenance (decision input 3) and record it.
5. Tick [manual-actions](../manual-actions.md) M1 with the date.

**Verification:** `npm whoami` returns the maintainer account; the org page lists the `@assay`
scope; every `npm view @assay/<pkg>` still 404s (nothing is published yet); a
`pnpm -r publish --dry-run` from the base tree resolves without a registry auth error (it must not
publish anything).

**Rollback / failure handling:** if the token leaks, revoke it on the npm token page and reissue. If
the claim fails or the scope turns out to be taken → STOP.

**Do not:**

- rename the scope unilaterally. [ADR 0039](../../adr/0039-product-name-assay.md) does name an
  example fallback ("adopt an alternative scope (e.g. `@assay-dev`) and codemod"), but the scope is
  an Accepted ADR's decision and a rename touches every manifest, the install copy and the naming
  record — treat a taken scope as a **stop** that requires a new ADR-level decision, not a codemod
  from this runbook;
- commit tokens or reuse a personal token with broader rights than the `@assay` org;
- create the account/org from an agent session.

**Evidence to record:** the naming-check outputs (dated), the org URL, token creation (identifier
only, never the value), the provenance decision, and the M1 tick in
[manual-actions](../manual-actions.md).

**Depends on:** none. R-15 depends on this item.

---

### R-17 — trademark / domain / product-name posture

**Status:** DECISION + HUMAN ACTION
**Owner:** maintainer (decision owner per [manual-actions](../manual-actions.md) M4); legal advice
must be obtained from a lawyer — this runbook provides none.
**Why it blocks:** G0 branding investment ([roadmap D6 tail](../../product/03-execution-roadmap.md);
[post-MVP](../../product/04-post-mvp-track.md) §4 item 5) and, per the
[index](20261122-remaining-work-handoffs.md), R-15.
**Facts (verified):**

- [manual-actions](../manual-actions.md):12 (M4): "Trademark / domain clearance for 'Assay' — D6 tail
  — required before branding investment (gate G0) — ⏳ open (G0 tail)".
- [ADR 0039](../../adr/0039-product-name-assay.md): name selected 2026-09-14; "Trademark/domain
  clearance search still required before branding investment (residual D6 tail, due at gate G0)";
  the alternatives considered are recorded there.
- The repository's licence is **AGPL-3.0-or-later** ([ADR 0036](../../adr/0036-agpl-license.md), root
  `LICENSE`, every manifest). Nothing in the repository is a trademark licence, and nothing claims a
  registration: the AGPL governs the code, not the name. That gap is exactly what M4 exists to
  close.
- No domain registration, trademark filing or clearance search result is recorded anywhere in the
  repository — **unknown; must be checked** outside it.

**Decision inputs:**

1. **Register or not:** file a trademark application for "Assay" (which classes — a lawyer decides),
   or rely on unregistered use plus a documented clearance search. Cost/registrability: obtain legal
   advice.
2. **Domain:** which domain(s), if any, to register and under whose control; renewal ownership must
   be named.
3. **Copy posture until registration exists:** no copy may claim registration. Usage of `™`/`®`
   follows legal advice — `®` is for registered marks only. Until M4 closes, marketing copy should
   describe the product and the AGPL licence and say nothing about trademark status.

**Steps:**

1. Inventory name usage: `grep -ri "assay" README.md docs/ --include="*.md" -l` — know the surface
   that a naming change would touch (it is large; ADR 0039 fixed the name pre-release precisely to
   keep this cheap).
2. Run and record a clearance search (external databases + web search for conflicting use in the
   software/data-tooling space) and a domain availability check. Save sources and dates.
3. Obtain legal advice on registrability, classes and the copy posture (decision inputs 1 and 3).
4. Decide: file (attorney-led; record application numbers) or disclaim/record the clearance result.
5. Register the chosen domain(s) under the maintainer's control; record registrar, expiry and
   renewal owner in [manual-actions](../manual-actions.md) (no registrar is prescribed here).
6. Run the copy check: no "registered trademark", `®`, or equivalent claim exists in docs or UI copy
   before a registration actually exists.

**Verification:** the search record and decision are stored with the M4 row; the copy-check grep
output is clean; if filed, the application numbers are recorded.

**Rollback / failure handling:** if the search finds a conflicting earlier right → stop branding
investment and escalate to the maintainer for a naming decision (which would supersede ADR 0039 via
a new ADR) — do not quietly rebrand or reword.

**Do not:**

- claim registration that does not exist; use `®` before registration;
- treat the AGPL code licence as any kind of name/trademark licence;
- state legal conclusions from this runbook, or ask an agent to file, register or purchase anything.

**Evidence to record:** the clearance-search record (sources + dates), the decision, any application
numbers, domain registration details (registrar, expiry, renewal owner), the copy-check output, and
the M4 tick in [manual-actions](../manual-actions.md).

**Depends on:** none. R-15 depends on this item; the legal posture is pursued in parallel.

---

### R-18 — telemetry collector hosting + public disclosure

**Status:** DECISION + HUMAN ACTION
**Owner:** maintainer ("Hosting decision is the maintainer's" —
[open-asks](20261019-open-asks.md) §1); procurement and deployment are human.
**Why it blocks:** the telemetry arc's last leg ([open-asks](20261019-open-asks.md) §1); the public
[disclosure](../../telemetry-disclosure.md) is already live (2026-10-19) and describes a collector
"operated by the Assay project" that does not exist yet.
**Facts (verified):**

- The collector service is **out of this repository**; this repo ships the client plus the
  [operator contract](../../engineering/07-telemetry-collector.md) (header; design OQ5: no
  server-side delete endpoint in v1).
- Client posture (operator contract §1): inert by default — no configured endpoint ⇒ nothing
  constructed, buffered or sent (design red line R6). Endpoints: CLI `ASSAY_TELEMETRY_ENDPOINT` /
  `ASSAY_TELEMETRY_TOKEN` at runtime; web at build time (Vite `define`, no default baked in).
  `https` always allowed; `http` only for loopback; anything else is inert
  (`packages/telemetry/src/endpoint.ts`).
- Wire contract (§2): `POST`, JSON array of events, ≤ 32 events / ≤ 256 KiB per request, optional
  `Authorization: Bearer <write-only ingest token>`; ≤ 2 retries on 5xx/timeout, 4xx dropped.
- Collector acceptance (§2.1): schema version 1 + the closed nine-event allowlist; `pipeline_run`
  rejected; unknown fields dropped before storage; request bodies never logged.
- Retention (§3): raw typed events 90 days (partition by receipt date), aggregates 24 months (no
  tokens), ops logs ≤ 14 days, IPs never persisted, unknown/rejected payloads never stored, backups
  ≤ raw window.
- Opt-out ([ADR 0037](../../adr/0037-telemetry-opt-out-consent.md)): `ASSAY_NO_TELEMETRY` |
  `--no-telemetry` | in-product preference; first-run disclosure before the first send; opting out
  emits nothing about the opt-out. Privacy boundary
  ([ADR 0025](../../adr/0025-telemetry-and-data-privacy-boundary.md)): no dataset contents, cell
  values, filenames/paths, SQL text, contract contents, column names or PII in any field.
- The stock endpoint-free builds must keep making **zero deliveries** — that promise is pinned by
  `tests/e2e/telemetry.spec.ts` on the stock build (per the header of
  `tests/visual/playwright.telemetry.config.ts`), and the CI `configured-telemetry` job proves the
  disclosure leg with `https://collector.example.invalid/ingest` while aborting every collector
  request in the browser (`.github/workflows/ci.yml`:181-255) — no metadata can be
  delivered even in the configured leg.
- Pre-live verification checklist (operator contract §4): https-only endpoint; ingest token accepted
  and never logged; a batch with an extra free-form field stores no extra field; `pipeline_run` and
  unknown majors rejected without body logging; 90-day raw disposal and 14-day log rotation actually
  scheduled; no IPs in any store or log.

**Decision inputs:**

1. **Hosting:** where the minimal collector runs (a VPS/cloud host is procurement; no provider is
   prescribed or recorded in this repo). The service must implement the operator contract §2.1/§3 —
   the contract is the specification whether the collector is written in-house or adopted.
2. **Endpoint + TLS:** the public URL and its certificate; https is mandatory off-loopback.
3. **Retention enforcement:** who schedules the 90-day raw disposal, 14-day log rotation and backup
   caps, and where that schedule is documented.
4. **Access control:** the ingest token is write-only and may be shipped in builds; read access to
   the store is limited to named humans (record who).
5. **Disclosure updates:** whether the endpoint URL is published in
   [telemetry-disclosure.md](../../telemetry-disclosure.md) and what wording changes if operation
   details differ from "self-hosted minimal collector".

**Steps:**

1. Choose the host and domain; provision TLS.
2. Deploy the minimal collector against the operator contract (§2.1 acceptance, §3 storage).
3. Generate the write-only ingest token; configure builds (web: build-time `ASSAY_TELEMETRY_ENDPOINT`
   - token; CLI: runtime env) — never bake the token into source.
4. Schedule retention (decision input 3) and record the schedule owner.
5. Run the §4 six-item checklist and record each result.
6. Prove the client legs: run the configured-disclosure leg locally (see Verification) against the
   real endpoint with delivery blocked at the network layer, then a controlled opt-in smoke from a
   scratch build whose events you can inspect in the collector (confirm the allowlisted fields only).
7. Update [telemetry-disclosure.md](../../telemetry-disclosure.md) if operation wording changes; keep
   its "Claim → source" table true; record the deployment in
   [open-asks](20261019-open-asks.md) §1.

**Verification:** the operator contract §4 checklist (all six items recorded); the local
configured-disclosure leg (`pnpm exec playwright test --config
tests/visual/playwright.telemetry.config.ts --retries=0` against a build with
`ASSAY_TELEMETRY_ENDPOINT` set, mirroring the CI job at
`.github/workflows/ci.yml`:181-255); a sample batch with a free-form field produces no
stored extra field; `pipeline_run` rejected; log inspection shows no bodies, payloads or IPs. While
Actions is billing-blocked (R-20) this local run is the substitute for the remote
`configured-telemetry` job.

**Rollback / failure handling:** removing the endpoint from builds makes every client inert again —
that is the built-in kill switch; rotate the ingest token on leak; on a privacy defect, stop
delivery, delete stored events per the retention policy and record the incident in
[handoff](../handoff.md) §9.

**Do not:**

- log or store raw request bodies, unknown fields, IPs, or anything outside the allowlist
  ([ADR 0025](../../adr/0025-telemetry-and-data-privacy-boundary.md) is absolute);
- add third-party analytics endpoints (operator contract §4: the only egress is the self-hosted
  collector);
- configure the stock endpoint-free builds to send anything — zero deliveries is a shipped promise;
- collect dataset contents in any form, including for "debugging".

**Evidence to record:** the deployment record (host, endpoint, TLS, retention schedule owner, access
list), the six checklist results, the local disclosure-leg output, any disclosure-doc diff, and the
[open-asks](20261019-open-asks.md) §1 tick.

**Depends on:** R-20 (for the remote `configured-telemetry` leg; local substitute documented above).

---

### R-19 — demo dataset sourcing

**Status:** DECISION + HUMAN ACTION
**Owner:** maintainer ("Curation is a non-code track (licensing + taste are yours)" —
[manual-actions](../manual-actions.md) O5 note).
**Why it blocks:** the MVP demo scenario ([product/02](../../product/02-mvp-scope-and-acceptance.md)
§5) and G0 ([post-MVP](../../product/04-post-mvp-track.md) §4 item 6: "curation not started"); also
produces the two synthetic study fixtures R-21 needs.
**Facts (verified):**

- O5 decided 2026-09-16: **hybrid** — real open data with deliberately injected flaws
  ([manual-actions](../manual-actions.md) O5 note;
  [post-MVP](../../product/04-post-mvp-track.md) §4 item 6).
- The demo scenario wants "Drop a **1+ GB** Parquet dataset into the browser" as step 1
  ([product/02](../../product/02-mvp-scope-and-acceptance.md) §5), then rows/nested/SQL/profile/
  validation/repair/export/diff plus the VS Code and CLI legs.
- Fixture policy (`fixtures/README.md`, from engineering/04 §3): "Fixtures
  must never contain real or sensitive data — synthetic data only"; "Keep fixtures small;
  large-scale performance datasets are generated by scripts … never committed wholesale".
  `fixtures/parquet/README.md`: "Large performance fixtures
  (multi-GB, M1 benchmarks) are generated on demand and never committed."
- [ADR 0038](../../adr/0038-duckdb-cli-fixture-generation.md) (Accepted): golden Parquet fixtures are
  produced by `fixtures/parquet/generate.sh` with the pinned DuckDB CLI (v1.5.5 at `DUCKDB=/tmp/duckdb`)
  from fully deterministic SQL; `manifest.json` carries filenames + SHA-256 checksums + descriptions;
  `packages/testing/src/fixtures.test.ts` verifies the manifest bidirectionally; CI regenerates and
  requires zero drift (`.github/workflows/ci.yml` verify job).
- Study fixtures per RD-T07 ([protocol](20261104-rd2-usability-protocol.md) §3): J1 exists
  (`fixtures/jsonl/nested.jsonl`, 12 rows × 10 columns, committed synthetic); **J2** (dataset A +
  contract with one failing scalar rule) and **J3** (comparison pair with a nonempty confirmed key)
  are "partially missing" and must be committed or documented before the first session; consent row
  §2: "Synthetic data only … the opened example file is synthetic".
- Size facts (measured at `6b2c9fd`): committed fixtures total ≈ 320 KB (`du -sh fixtures/*`;
  largest directory `fixtures/dcr/` at 84 K). Generated benchmark pairs run 239 KB – 23 MB per file
  ([measurement rows](20261121-measurement-rows-b6-c3-c2.md) §1.1), generated under `/tmp` and never
  committed. **No numeric committed-size cap is documented** — "keep fixtures small" is the rule
  (assumed intent: nothing beyond small canonical fixtures is ever committed).
- Environment limits relevant to any generated artefact
  ([measurement rows](20261121-measurement-rows-b6-c3-c2.md) §0/§4): one contended 16-core host,
  repo and `/tmp` share one NVMe; fixtures are warm-cache only and synthetic.

**Decision inputs:**

1. **Source:** which public open dataset (or a fully generated/synthetic one). Its licence must
   permit redistribution **and derivative works** — the injected flaws make the demo artefact a
   derivative. Licence compatibility must be checked and recorded per dataset; no licence text is
   interpreted in this repository.
2. **Artefact size/shape:** ≥ 1 GB to match the demo scenario step 1 (or document a smaller stand-in
   and its limitation); the artefact is generated or downloaded on demand and **never committed**.
3. **Flaw set:** which injected flaws the demo needs (the scenario's validation → repair → diff legs
   at minimum).
4. **Study fixtures:** commit the J2/J3 synthetic pairs (protocol allows "commit or document") —
   small, synthetic, with the manifest pattern.

**Steps:**

1. Record candidate sources with licence + provenance; reject any licence incompatible with
   redistribution/derivatives and any dataset with real sensitive data (open data is not
   automatically non-sensitive — screen it).
2. Write the deterministic curation script (pattern: `fixtures/parquet/generate.sh`): fetch or
   generate the source → inject the flaws with fixed seeds (no unseeded randomness, no timestamps
   without fixed values — ADR 0038) → write the artefacts with the pinned DuckDB CLI
   (`DUCKDB=/tmp/duckdb`).
3. Write a `manifest.json`: artefact filenames, SHA-256 checksums, descriptions, source URL, licence
   identifier, retrieval date, generator script + pinned CLI version. Provenance without a checksum
   is not provenance.
4. Create the two synthetic study fixtures (J2: dataset A + contract, one failing scalar rule; J3:
   comparison pair, nonempty confirmed key) — synthetic-only, small, committed or documented with
   regeneration instructions, per [protocol](20261104-rd2-usability-protocol.md) §3.
5. Walk the demo scenario ([product/02](../../product/02-mvp-scope-and-acceptance.md) §5) once
   against the artefact; record which of the twelve legs it exercises and which need a different
   input.
6. Confirm nothing large or real entered git: `git status`, `du -sh fixtures/*`, and the manifest
   check (`packages/testing/src/fixtures.test.ts` pattern) for anything committed.

**Verification:** `sha256sum -c` (or the manifest test) matches; re-running the script reproduces
the artefact byte-identically or the non-reproducible parts are named (the
[measurement rows](20261121-measurement-rows-b6-c3-c2.md) §5 discipline); the J2/J3 fixtures drive
the documented "repair one value → stale → recheck" and comparison paths; the licence + provenance
record is complete.

**Rollback / failure handling:** a licence found incompatible after the fact → delete the artefact
and its generated copies, re-source, record the incident; sensitive data discovered → delete
immediately and record; checksum drift on regeneration → treat as a deliberate change requiring a
manifest update in the same reviewed commit (ADR 0038).

**Do not:**

- commit real or sensitive data, or any large artefact (the 1+ GB demo dataset stays generated or
  downloaded; the committed side stays small and synthetic);
- upload a dataset anywhere — the product is local-first and the study is local;
- use a dataset whose licence you have not recorded; claim provenance without a checksum;
- silently "clean up" real open data into something unrecognisable and call it synthetic.

**Evidence to record:** the manifest + licence/provenance records, the curation-script commit, the
demo-scenario walkthrough record, the J2/J3 fixture entry, and the O5 tick in
[manual-actions](../manual-actions.md).

**Depends on:** none. R-21 depends on this item for the two synthetic study fixtures.

---

### R-20 — GitHub Actions billing restore + first real CI run

**Status:** HUMAN ACTION
**Owner:** account owner / maintainer only ("only the maintainer may change billing/limits"; "No
agent billing, secret, visibility, public-repo or self-hosted-runner workaround authorized" —
[manual-actions](../manual-actions.md) M6).
**Why it blocks:** the remote CI signal for every push and for R-15 step 7; until it is restored,
every push shows four job-start refusals ([decision round](20261121-decision-round.md) §4).
**Facts (verified):**

- On 2026-11-21 the docs-only run `44887930938` (`c2af086`) had **all four jobs refused at start**
  with "recent account payments have failed or your spending limit needs to be increased"
  ([open-asks](20261019-open-asks.md):98-101; [successor queue](20261121-successor-queue.md) §0:
  ~4-second failures, no steps, no logs). It is not a code or workflow failure.
- The last executed run is `44886310732` on `71a67fc` — **green** across all four jobs
  ([open-asks](20261019-open-asks.md):85-87).
- That green run is also the run that **proved the three environment quirks fixed** in `4192db6` +
  `71a67fc` (open-asks:89-96):
  1. **type-aware lint heap** — measured ≈ 3 GB RSS on the runner; the verify job sets
     `NODE_OPTIONS: --max-old-space-size=4096` (`.github/workflows/ci.yml`:74-78, "a
     2 GB heap aborts with 'Ineffective mark-compacts'");
  2. **DuckDB CLI path** — the repo convention and jobs use `/tmp/duckdb`;
     `.github/actions/install-duckdb/action.yml` now installs the pinned v1.5.5 binary at both
     `/usr/local/bin/duckdb` and `/tmp/duckdb` ("so the vscode-verify job's `DUCKDB` env and the e2e
     specs that spawn the CLI resolve on a clean runner"); `vscode-verify` exports `DUCKDB:
/tmp/duckdb` (`.github/workflows/ci.yml`:265);
  3. **VS Code job must build workspaces first** — `vscode-verify` runs "Build packages for the
     installed-CLI agreement leg" (`pnpm build`) before the e2e leg
     (`.github/workflows/ci.yml`:314).
- The four jobs (`.github/workflows/ci.yml`): `verify` (typecheck / lint / test / build, line 22),
  `e2e` (playwright e2e, line 108), `configured-telemetry` (configured telemetry disclosure
  (isolated), line 181), `vscode-verify` (VS Code real extension host / offline harness, line 257).
  All four use `node-version-file: .node-version` (Node 24).
- Records disagree on M6's state: [manual-actions](../manual-actions.md):14 still reads "⏳ await
  latest-main CI verification" while [open-asks](20261019-open-asks.md) §1 ticks M6 "DONE 2026-11-21"
  and lists a _new_ open billing row. Resolve the ledger when closing (see Evidence).

**Decision inputs:**

1. **Which account fix applies:** a failed payment method and/or a spending limit that needs raising
   — the annotation names both; the actual account state is outside the repository and **must be
   checked** in GitHub → Settings → Billing & plans.
2. **Trigger for the first real run:** re-run `44887930938` (`gh run rerun 44887930938`) or let the
   next push trigger fresh runs — the run that matters is one on the current `main` head.

**Steps:**

1. GitHub → account **Billing & plans**: repair the payment method and/or raise the spending limit;
   confirm the account is in good standing. No agent involvement.
2. Confirm the guardrails hold: no agent-managed billing, secrets, visibility change or self-hosted
   runner was introduced as a workaround.
3. Trigger a run on the current `main` head (`gh run list --branch main --limit 5`, then
   `gh run rerun <id>` or push the next batch).
4. Confirm the run **starts steps**: job logs must show checkout / `pnpm/action-setup` /
   `pnpm install` — not a 4-second failure with no logs.
5. In that first real run, check the three quirks specifically: the verify job's lint step carries
   the 4096 heap and passes; the DuckDB step logs `duckdb --version` and `/tmp/duckdb` exists for the
   e2e and vscode jobs; `vscode-verify` executes "Build packages for the installed-CLI agreement
   leg" before `e2e`. Also expect the fixture zero-drift step and the pack-consumer smoke in
   `verify`.
6. A red step at this point is finally code signal — triage it as such (the contention-sensitive
   list in [index](20261122-remaining-work-handoffs.md) §0 still applies to flaky shapes).

**Verification:** the run URL with all four jobs executing steps; per-job evidence for the three
quirks (step names + log excerpts); the run is not the 4-second no-log shape. Record the run URL.

**Rollback / failure handling:** if billing cannot be restored, the local suite remains the
verification authority ([successor queue](20261121-successor-queue.md) §0); do not retry pushes to
"fix" a billing refusal; record each attempt and its date.

**Do not:**

- read job-start refusals as code signal, or retry pushes to clear them;
- let an agent touch billing, secrets, visibility or runner configuration;
- close M6 on the strength of a docs-only run — check the three named steps in a run that executes
  them.

**Evidence to record:** the billing fix (date, what was wrong — no payment details), the first real
run URL with per-job step evidence, the resolution of the manual-actions/open-asks M6 disagreement
(one ledger must win), and the [handoff](../handoff.md) §2 observation entry.

**Depends on:** none. R-15 (step 7) and R-18 (remote disclosure leg) want this closed first.

---

### R-21 — RD-T07 usability study

**Status:** DECISION + HUMAN ACTION
**Owner:** maintainer (recruitment, compensation, moderation; two counters are needed for the first
session).
**Why it blocks:** RD-T07 is the only legitimate way to make a usability claim — D-02 option B in the
[RD decision sheet](20261104-rd-open-decisions.md) §D-02 ("B is the only thing that can legitimately
support a usability claim"). Until it runs, no "validated", "intuitive" or "easier" wording may
appear anywhere ([decision round](20261121-decision-round.md) §3 D-02 row;
[index](20261122-remaining-work-handoffs.md) §4).
**Facts (verified):**

- The [protocol](20261104-rd2-usability-protocol.md) is prepared (2026-11-04) and **not run**:
  "protocol prepared; no session has been run. There is no human usability evidence for either
  alternative."
- The standing decision is **D-02 A** (explicit accepted limitation), reopenable "only by running
  the prepared 5–8 participant protocol" ([decision round](20261121-decision-round.md) §3).
- Sample and logistics ([protocol](20261104-rd2-usability-protocol.md) §2): **5–8 participants**
  starting with 5; ≥ 2 newcomers to data tooling and ≥ 2 experienced data-tool users where
  available; one-to-one moderated 45-minute sessions, script verbatim; counterbalanced order
  (half baseline-first).
- Materials (§2–§3): the built app at one known revision; the two isolated prototypes
  `assests/prototypes/rd-*.html` (the directory is literally spelled `assests/` —
  `rd-nav-a.html` / `rd-task-led-b.html`) for the structure comparison; one synthetic fixture set —
  J1 exists (`fixtures/jsonl/nested.jsonl`), **J2 and J3 are missing** and must be created/documented
  first (R-19). "Round 2 must run on the rd-4 slice" — prototype results are structural only.
- Tasks J1–J4 with verbatim prompts (§4); J2 (contract → finding → row → typed repair → stale →
  explicit recheck) is the primary journey. A stuck participant gets the smallest nudge after 60 s
  and the task counts as incomplete without direction.
- Measures and counting rules (§5): task completion with denominators; **critical misconception** —
  any occurrence fails the study gate; avoidable round trips counted from a live, local action log
  (two moderators independently count session one as calibration); help dependence; next action
  identified within 30 s; ease 1–7 per task; task time (medians, never a universal limit).
- Provisional exit criteria (§5, agree before session one and freeze): ≥ 4 of the first 5 complete
  each core task unaided; **zero** critical misconceptions; ≥ 4 of 5 identify the next action after
  a stale verdict without Help; median ease ≥ 5/7 per core task with no median task-time regression
  vs baseline; ≥ 20 % fewer avoidable round trips on J2 for the candidate; one keyboard-only
  walkthrough; one assistive-technology review attempted (record absence if unavailable).
- Analysis/decision rule (§6): tabulate per participant (order, completion, round trips, time, ease,
  misconceptions); report counts and denominators — "never invent a percentage from five people";
  adopt the candidate only if it meets the J2 round-trip and next-action criteria with no critical
  misconception; record limitations; a maintainer acceptance of a limitation "is recorded explicitly
  and never labelled 'user-validated'".
- Privacy ([protocol](20261104-rd2-usability-protocol.md) §2): anonymous aggregate notes only (no
  names, no employer data, no screen/audio recording, no upload); notes stay on the moderator's
  machine and are destroyed after the aggregate table is written into the design record
  ([13-workbench-redesign-design-record.md](../../product/13-workbench-redesign-design-record.md));
  consent: synthetic data only, voluntary, stop at any point, nothing typed leaves the machine.
  Compensation is out of the protocol's scope — a maintainer decision.
- RD-T07's acceptance row names what must be recorded: "observed baseline/candidate task results,
  denominator, wrong turns, safety/ease/time and limitations"
  ([12-workbench-redesign-review.md](../../product/12-workbench-redesign-review.md) RD-T07 row).
- The 2026-11-04 agent heuristic walkthrough ([protocol](20261104-rd2-usability-protocol.md) §7) is
  explicitly **not** human evidence and must never be presented as such.

**Decision inputs:**

1. **Reopen D-02 as B** — the standing decision is A; record the reopen explicitly before anything
   else.
2. **Compensation** for participants (protocol leaves it to the maintainer).
3. **Moderation:** who runs the sessions and who is the second counter for the session-one
   calibration.
4. **Candidate build:** prototype results are structural only — a claim-grade study waits for the
   built rd-4 candidate. Decide whether to run the baseline-only round now or wait and run both.
5. **Freeze the provisional exit criteria** (§5) as agreed before session one; they may not move
   afterwards.

**Steps:**

1. Record the D-02-B reopen (with decision input 5's frozen criteria).
2. Prepare materials: the built baseline (`pnpm build` + fresh preview per the
   [map §6](20261104-svg-implementation-map.md) protocol, stock bundle — no configured telemetry);
   the candidate build (decision input 4); the J2/J3 **synthetic** study fixtures (R-19).
3. Recruit 5–8 participants to the §2 mix; agree compensation; obtain consent per §2.
4. Run sessions: counterbalanced order, verbatim prompts, no location hints, the 60-second nudge
   rule, a timestamped local action log (no recording), two independent counts on session one.
5. Tabulate the aggregate table per §6 (per participant: order, completion, round trips, time, ease,
   misconceptions; counts with denominators) into the design record.
6. Apply the §6 decision rule. Any critical misconception → correct the design and re-test (the
   criterion is zero). Record limitations next to the result.
7. Only after a passing study may "validated"/"intuitive"/"easier" wording be considered — and only
   as strongly as the study supports it.

**Verification:** the aggregate table exists in
[13-workbench-redesign-design-record.md](../../product/13-workbench-redesign-design-record.md) with
denominators; the protocol's missing-evidence register (§8) is updated (sessions no longer
"Missing"); no recordings or uploads exist (attested by the moderator); session notes are destroyed
after transcription.

**Rollback / failure handling:** if the criteria are not met — keep A's accepted-limitation wording,
return to the design record per §6 rule 5, and do not re-cut the criteria to pass. If a critical
misconception appears anywhere, the study gate fails regardless of other numbers.

**Do not:**

- invent participants or results ("No participant was invented" is the protocol's own register
  line); run the study on the prototype and claim product usability; move the exit criteria after
  session one; record names, employers, audio or screen recordings; upload any study artefact;
- present the agent walkthrough, automated tests or the rehearsal as user validation;
- write "validated"/"intuitive"/"easier" anywhere before a passing study (this is a standing copy
  rule, not a suggestion).

**Evidence to record:** the D-02-B decision entry, the frozen exit criteria, the anonymous session
log, the aggregate table in the design record, the updated missing-evidence register, and the
attestation that raw notes were destroyed.

**Depends on:** R-19 (the two synthetic study fixtures), plus human recruitment and a compensation
decision.

---

### R-22 — re-widening the Node floor to 22 (conditional)

**Status:** DECISION + HUMAN ACTION
**Owner:** maintainer (decides on the consumer evidence); a Node 22 runtime must be provisioned for
the gate run.
**Why it blocks:** nothing today — this item exists only so the narrow floor is never widened
informally. It becomes live **only if a real Node 22 consumer appears**
([decision round](20261121-decision-round.md) §1: "If a Node 22 consumer ever appears: re-widening is
a manifest change plus a 22-line gate run").
**Facts (verified):**

- Current floor: `node: "^24.0.0"` on the root and twelve product manifests —
  `apps/{cli,web,vscode}` and
  `packages/{contracts,data-sources,diff,domain,engine-duckdb,grid,pipeline,telemetry,validation}`;
  the eight scaffold packages declare no `engines` block
  ([node support contract](20261120-node-support-contract.md) §2 table).
- The old `>=22` claim was never exercised (this host has only Node 24.13.0) and was narrowed
  2026-11-21 (C4; recorded as minor in `.changeset/c4-node-floor-24.md` — "a published version would
  have made this a major"). Nothing is published, so no released artifact is narrowed.
- `pnpm current-state:check` fact 6 `product-node-floor`
  (`scripts/check-current-state.mjs`:39-47) enforces the floor: source of truth is the root
  `package.json` `engines.node`; **every** `apps/<dir>`/`packages/<dir>` manifest that declares
  `engines.node` must equal that string exactly, and the three shipped apps must declare it (silent
  removal is drift too).
- Fact 1 `dev-node-policy` (`scripts/check-current-state.mjs`:13-20) additionally couples the range
  to `.node-version` and to the AGENTS.md / README.md "Development requires" paragraphs (both read
  "Node 24 (root policy `^24.0.0` …)" at AGENTS.md:58, README.md:40) and to the exact string quoted
  in [20261120-node-support-contract.md](20261120-node-support-contract.md) §1. Its major regex
  takes the **first** major of the range, so range ordering matters (see Steps).
- Tooling floors on a 22-line run: `eslint@10.11.0` needs `^22.13.0` or later on the 22 line (not
  bare 22.0.0); `vitest@4.1.11` accepts `^22.0.0`
  ([node support contract](20261120-node-support-contract.md) §2).

**Decision inputs:**

1. **Evidence threshold:** what counts as "a real Node 22 consumer" — a named downstream that runs
   the CLI or libraries on Node 22, with a reproduction. Mere speculation re-opens nothing.
2. **Claim shape:** the claim must stay honest — either a gate run on 22 backs it or the range names
   what was tested. A bare `>=` is forbidden (the C4 review rejected `>=24` for exactly this
   reason); prefer a range whose **first** major matches `.node-version` (e.g. `^24.0.0 ||
^22.13.0`) so fact 1 keeps parsing 24.
3. **Scope:** widening only the published library packages vs the apps too — fact 6 demands one
   identical string across every declaring manifest, so partial widening fails the gate.

**Steps:**

1. Record the consumer evidence (decision input 1).
2. Change the range in the two coordinated places (the enforcement makes this a two-place change):
   a. the **manifests** — root `package.json` `engines.node` (the source of truth) **and** all
   twelve product manifests to the byte-identical new string (fact 6 checks exact equality;
   decision input 3 makes partial changes impossible);
   b. the **fact-1 surface** — `.node-version`, the AGENTS.md:58 and README.md:40 "Development
   requires" paragraphs, and the exact-string quote in
   [20261120-node-support-contract.md](20261120-node-support-contract.md) §1 must all agree with
   the new range's first major (decision input 2).
3. Provision Node 22 ≥ 22.13.0 (the ESLint floor) and run the full
   [verification protocol](#verification-protocol) on it — that is the "22-line gate run" the
   contract requires. Record it as the claim's evidence; unexercised 22 lines stay unclaimed.
4. Record the widening as a changeset (semver: unpublished, so minor; the C4 changeset is the
   precedent) and update the node support contract's "Separately recorded tested versions".

**Verification:** `pnpm current-state:check` green with the new strings; the complete local suite
green under Node 22 (record `node -v` and every gate exit); no manifest left on the old range
(`grep -rn '"node":' apps/*/package.json packages/*/package.json` shows one identical string in the
twelve manifests + root).

**Rollback / failure handling:** if the Node 22 run fails any gate, revert the manifest/docs change
entirely and report to the consumer that Node 24 is the supported floor — do not ship a range the
gates do not back.

**Do not:**

- widen the floor without a Node 22 gate run — that reinstates the exact unverified-claim shape C4
  removed;
- use a bare `>=` range (it claims Node 25+ that no gate runs);
- change the root without the twelve manifests or vice versa (fact 6 fails, correctly);
- forget the fact-1 surface (`.node-version`, AGENTS.md, README.md, the contract quote) — the gate
  will point at them.

**Evidence to record:** the consumer evidence, the manifest/docs diff (two places), the Node 22 run
record (`node -v` + gate exits), the changeset, and the contract update.

**Depends on:** a real Node 22 consumer (decision input 1). Nothing else in H3.

---

## Verification protocol

**Local gates are the authority while GitHub Actions is billing-blocked (R-20).** Remote job-start
failures are not code signal. The full command list, the recorded base evidence and the
contention-sensitive test list live in the
[index](20261122-remaining-work-handoffs.md) §0 — run that suite on a clean tree before and after
every action here, and paste the command tails into the item's evidence record. Per-item additions:

- **R-15:** run the suite on the _cut_ tree (after `pnpm changeset version`), plus
  `node apps/cli/scripts/pack-consumer-smoke.mjs` and the scratch-consumer post-publish check
  (step 10). The pack smoke is the registry-free substitute for an installability claim.
- **R-16:** `npm whoami`, `npm view @assay/<pkg>` (404 before release), `pnpm -r publish --dry-run`.
- **R-18:** the configured-disclosure leg — `pnpm exec playwright test --config
tests/visual/playwright.telemetry.config.ts --retries=0` against a build with
  `ASSAY_TELEMETRY_ENDPOINT` set (the local substitute for the CI `configured-telemetry` job), plus
  the operator contract §4 six-item checklist.
- **R-19:** checksum verification of every artefact (`sha256sum -c` / the manifest test), a clean
  `git status` proving no large or real data was committed, and the demo-scenario walkthrough record.
- **R-21:** the aggregate table in the design record with denominators — study evidence is
  participants, not gates; no gate can stand in for it.
- **R-22:** the same suite under Node 22 ≥ 22.13.0 is itself the deliverable.

## Paste-ready prompt

Maintainer-driven session: the human performs every account, console, legal, procurement and
participant step; the agent prepares, verifies and records. Adapt `SELECTED_ITEM` per run.

```text
You are running one human-operational runbook item for Assay from
docs/process/handoff/20261122-h3-human-runbooks.md (H3). The repository is local at
/home/howt/work/dataworkbench; remote GitHub Actions is billing-blocked (four job-start failures per
push are NOT code signal).

Read, in order: AGENTS.md; docs/process/handoff.md (current-state block);
docs/process/handoff/20261122-remaining-work-handoffs.md §0 (verification protocol) and §2 (dispatch
envelope); the selected runbook item in the H3 file and every record it cites.

SELECTED_ITEM = <R-n>        # exactly one of R-15 … R-22
DECISIONS = <the options chosen, if the runbook's Decision inputs ask for any>

Your role is preparation, verification and recording only. You do not create accounts, publish,
register domains or trademarks, buy anything, handle credentials, contact participants, upload
datasets, or change billing. The maintainer performs those steps and pastes their output; you
prepare the exact commands/console actions up front, run the read-only repository checks, verify the
outcome against the pasted evidence and the repository, and write the evidence record.

Work the runbook's Steps in order. After the maintainer's action, run the item's Verification
section (plus the H3 Verification protocol) and record exact commands and exits. On any mismatch
between what the runbook expects and what you observe, stop (BLOCKED, not CLOSED) and report.

Never weaken a licence, privacy, retention or fixture rule; never record a claim the evidence does
not support (unverified account/legal/hosting facts stay "must be checked"); never present
automation as human evidence. Report: item id, decision inputs chosen, actions the maintainer took
(commands/console steps), verification outputs, the evidence record written, and remaining limits.
```
