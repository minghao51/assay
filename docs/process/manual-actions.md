# Manual Actions — human-only execution track

Things agents can't (or shouldn't) do: account creation, credentials, legal
clearance, gate sign-off. **Orchestrator-owned**; agents propose additions,
never execute entries here. Check items off with date (+ commit/PR) when done.

| #   | Action                                                                                                                                              | Why / what it unblocks                                                                                                                                      | Owner                                                  | Status             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------ |
| M1  | Claim the `assay` **org on npm** (npmjs.com → orgs → `assay`) with the maintainer account                                                           | The unscoped `assay` name is taken; the `@assay/*` scope must be ours **before first publish** (ADR 0039 / D6 tail)                                         | maintainer                                             | ⏳ open            |
| M2  | Create the **GitHub org/repo** (org `assay`, repo suggestion: `assay`), add as `origin`, push `main`                                                | Hosting decided 2026-09-16 (GitHub). Unlocks: remote CI (verify + e2e jobs already authored, never yet run remotely), PR review flow, dependabot/visibility | maintainer                                             | ⏳ open            |
| M3  | After the first push: confirm GitHub Actions run green on `main`; then SHA-pin `actions/*` versions in `.github/workflows/ci.yml` (m1-8 carry-over) | Supply-chain hardening (risk R13); keeps DuckDB 1.5.5 in sync across both ci.yml blocks + `manifest.json`                                                   | maintainer (+ agent for the pin edit as a normal task) | ⏳ blocked by M2   |
| M4  | Trademark / domain clearance for "Assay"                                                                                                            | D6 tail — required before branding investment (gate G0)                                                                                                     | maintainer                                             | ⏳ open (G0 tail)  |
| M5  | Record the **G1 gate / M1-exit decision** once task G1-R (multi-GB re-run) has landed                                                               | Maintainer-only call (handoff §6); the orchestrator records the paperwork in roadmap §4/§5 + handoff §9 afterwards                                          | maintainer                                             | ⏳ blocked by G1-R |

Related decisions already made (2026-09-16, maintainer):

- **Git hosting: GitHub** — see M2/M3 for execution.
- **Telemetry (D2b, narrowed):** self-hosted minimal collector — allowlisted,
  metadata-only events per ADR 0025. Remaining normal work: event-schema +
  sampling design doc (pre-G0; a §6 design task when wanted).
- **Demo dataset (O5):** hybrid — real open data with deliberately injected
  flaws. Curation is a non-code track (pre-G0; best after M2–M4 give it
  something to demo).
