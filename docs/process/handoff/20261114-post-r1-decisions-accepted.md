# Post-R1 decisions accepted — 2026-11-14

**Status:** maintainer acceptance recorded. On 2026-11-14 the maintainer accepted **all recommendations**
in the [decision sheet](20261114-post-r1-decision-sheet.md) ("accept all the recommendation and proceed").
This record is the authority the successor briefs cite; the decision sheet remains the options/evidence
record, not an approval.

**Authority order:** accepted ADRs → this acceptance record → [EW-10 §8](20261113-ew10-first-wave-integration.md)
dated selection → the [post-R1 pickup](20261114-post-r1-pickup.md) → the contracts. Rule zero still
applies: the cited records are evidence, not authority; every runtime row records its own clean SHA and
fresh gates.

## Accepted decisions

| ID  | Accepted                                                                                                                                                                                                                                                                                                                                           | Effect                                                                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| D2  | The three EW-02D sentences **accepted verbatim**; pager disclosure **RETAIN**; profile/filter symmetry **RETAIN**                                                                                                                                                                                                                                  | EW-02I may be briefed now, with the byte-exact strings pasted into the brief                             |
| D3  | The EW-03D ledger **accepted as a block**; D12's ADR route kept separate; D15 recorded as a standing rule                                                                                                                                                                                                                                          | EW-03I scope exists, but no runtime row before D12's ADR is accepted; D10 is unblocked                   |
| D4  | D16 **wrapped DESCRIBE + restructured cast check** (subject to the composition probe); D17 **literal rewrite iff conformance tests**; D15 cap **x ≤ 500**; D14 **ADR before runtime**; U1–U3 **close inside EW-04I with named tests**; D11 **stacked-projection qualifier** accepted; export budget **(a) published envelope + pre-apply refusal** | EW-04I remains gated on (ii)–(vii); the composition probe, U5 and the D14 ADR are the next prerequisites |
| D5  | U5 funded as a **standalone test-only row before EW-04I**                                                                                                                                                                                                                                                                                          | Closes verdict condition (vii) independently                                                             |
| D6  | R2 fixed at the **projection boundary** in `apps/web/src/grid/provider.ts` with a minimal golden fixture; R3 keeps **RD-T07 as a recorded limitation**                                                                                                                                                                                             | R2 becomes a small web/grid row (serialized after EW-02I); no usability claim is made                    |
| D7  | R8 **no new fixture**; the real-engine N9/T9b case stays recorded as unasserted (RTL injection remains the evidence)                                                                                                                                                                                                                               | No fixture work; R6 already makes retention accounting unassertable at runtime                           |

## What this authorizes, and what it does not

**Authorized now:** the three read-only probes (D16/D17 composition, R2 root cause, D12 ADR draft);
**EW-02I** (small web runtime row); the **U5** test-only row; the **D12** and **D14** Proposed ADRs; the
R2 row after EW-02I (one web-runtime writer at a time).

**Not authorized by this record:** EW-03I before the D12 ADR is accepted; EW-04I before (ii)–(vii) are
closed; any EW-05…08 or R13 row; any protocol, dependency, lockfile or telemetry-semantic change; any
push, release, publication or visibility change.

**Implementation note (2026-11-14, factual correction):** U5 cannot be a _pure test-only_ row. The
`column-repair` op and the composer wrap do not exist yet (EW-04D §4.2: "neither representation exists
today"), so "real composer/domain behaviour" can only be pinned once that code exists. Funding U5 is
therefore realized as the **UI-free domain + engine slice** of EW-04I (op + fold + wire parser + composer
wrap + the §11 tests), merged and reviewed **before** any web UI or plan-capture code. That still closes
condition (vii) before the UI row and preserves the intent of D5; it is not a test-only change. The
slice remains gated on the D14 ADR and on D16/D17 being pinned.

**R3/R8 disposition:** both remain recorded limitations. No study is commissioned (R3) and no fixture is
reserved (R8) under this acceptance; either can be re-decided later with its own request.

## Integration rules carried from the decision sheet

Every runtime row: filled envelope, branch/worktree, shifted ports, one web-runtime writer, full stock +
configured + restored gates, an independent reviewer (different model and thinking) with at least two
mutation drills and byte-identical restoration. Never push.
