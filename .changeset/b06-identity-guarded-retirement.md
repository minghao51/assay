---
'@assay/testing': patch
'@assay/data-sources': patch
---

test(b06): actually pin the identity-guarded retirement of a failed acquisition attempt. The B06
claim "an older rejection can never clear a newer attempt" was not falsifiable by the tests it
shipped with: a single-slot cache can only be cleared by the handler of the attempt it currently
holds, so the reviewer's mutation — clearing identity-blind (`this.#file = null` unconditionally) —
passed every targeted suite (`browser-file-source.test.ts`, the `acquisition-retry` conformance
scenario, and the suite's own mutation tests). That mutant is behaviourally equivalent outside
re-entrancy, where the cached attempt is always the failing one.

What can observe the guard is a handle that re-enters the source: `handle.getFile()` is external
code the source calls synchronously, so a handle that calls back into the source while an
acquisition is being created makes the source cache its own (outer) attempt while a nested attempt
exists. The nested attempt is no longer the cached one, and its failure must leave the cache alone —
an identity-blind retirement drops the still-in-flight attempt and forces a third acquisition. That
flow is now pinned in three places: the package unit test
(`browser-file-source.test.ts` — "a failed attempt that is no longer the cached one cannot retire
the cached attempt"), the shared `acquisition-retry` scenario (Node vitest, browser harness, e2e —
via the new additive `supersededAttemptCannotClearCache` fact), and the suite's own mutation set
(new `immediateUnconditionalClear` fake, proven to fail the scenario). Under the identity-blind
mutant the unit test now fails (`expected 3 to be 2`) and the scenario reports "a failed attempt
that is no longer the cached one must not retire the cached attempt (no extra acquisition): expected
2, got 3"; on the shipped code both pass. Existing assertions, scenario names and the
`dataSourceBehaviorScenarioNames` list are unchanged. `@assay/data-sources` changes here are
documentation and tests only (module docs state the identity-guarded contract precisely, the README
lists it) — the runtime acquisition semantics are unchanged.
