---
'@assay/testing': patch
'@assay/data-sources': patch
---

fix(au3-11): de-harden two self-blind oracles. The data-source behavior suite
now derives its `metadata-contract` probe matrix from the subject's own
`formatByExtension` detect map (the shipped adapter declares the newly exported
`FORMAT_BY_EXTENSION`) instead of a hand-copied format list: every detected
format must have a `FORMAT_BEHAVIOR_MATRIX` slot or the scenario fails loudly
at setup, so `arrow`/`feather` are now proven by the mandated same-suite rather
than by unit tests alone (case-insensitive detection and the `unknown` outcome
stay covered). The engine-conformance e2e spec imports
`engineConformanceScenarioNames` and derives one test per exported scenario,
with a button-label completeness precondition that fails at collection time —
a new suite scenario can no longer silently never run in e2e. The
`data-source-behavior` e2e `casesProbed` evidence follows the derived count.
