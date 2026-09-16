---
'@assay/data-sources': patch
---

test(t3): wire BrowserFileSource into the shared data-source behavior suite — a subject adapter (`src/behavior-subject.ts`, internal module) providing in-memory handles for Node vitest and accepting an OPFS stager for genuine browser handles; the harness hosts the adapter with OPFS staging and `tests/e2e/data-source-behavior.spec.ts` runs all six scenarios against the real implementation in Chromium. No product semantics changed: the shipped m1-3/m1-4 behavior already matched the contract (cancel settles `null`, metadata is format+size only, one-shot `getFile`, frozen idempotent handle).
