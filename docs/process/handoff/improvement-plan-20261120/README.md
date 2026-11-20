# Improvement plan (2026-11-20) — planning artifacts

**Status:** preserved planning bundle for the post-MVP improvement track. Execution is
recorded in [../20261120-improvement-plan-execution.md](../20261120-improvement-plan-execution.md);
this folder is evidence/history, not dispatch authority.

| File                                             | Purpose                                                                    |
| ------------------------------------------------ | -------------------------------------------------------------------------- |
| [implementation-plan.md](implementation-plan.md) | Full task specifications, acceptance matrices, dependencies, stop rules.   |
| [tasks.json](tasks.json)                         | Machine-readable queue (all rows initially `proposed`).                    |
| [START-HERE.md](START-HERE.md)                   | Cold-pickup orientation for the bundle.                                    |
| [evidence-notes.md](evidence-notes.md)           | Directly inspected planning sources and boundaries.                        |
| [plan-review.md](plan-review.md)                 | Independent planning review and disposition (not implementation approval). |
| [dispatch-envelopes.md](dispatch-envelopes.md)   | First-slice reservations, worker envelope, reviewer prompt.                |

The Phase 1 audit tarball referenced by `evidence-notes.md` is **not** committed (large, and its
generation scripts are not implementation truth). The original bundle is preserved outside the
repository at the planning host.

These documents describe a baseline (`e68bde9`) and source observations at planning time. Line
anchors may drift; re-check a claim against current source before acting on it. Accepted ADRs
remain authoritative over anything written here.
