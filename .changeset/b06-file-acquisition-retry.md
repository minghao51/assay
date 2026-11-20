---
'@assay/data-sources': patch
'@assay/testing': patch
---

fix(b06): give `BrowserFileSource` deliberate acquisition-retry semantics (decision Q3) instead of caching a permanent failure. The lazily acquired `File` is now **one in-flight attempt**: concurrent `open()`/`metadata()`/`getFile()` calls share it and all observe its outcome; a **failed** attempt is retired only while it is still the cached attempt (so an older rejection can never clear a newer one) and the next call retries exactly once; a **fulfilled** attempt is retained for the instance lifetime and its `File` is never re-fetched because the file changed on disk. A synchronous `getFile()` throw is captured into the same attempt path, so the accessor never throws synchronously. Still no logging of the source/file name (ADR 0025); the `DataHandle` stays `{kind, sourceId}` and frozen; the fallback path never invokes a handle or reads dataset bytes.

`@assay/testing` gains the additive `acquisition-retry` scenario in the shared data-source behavior suite (seven scenarios now), so every adapter is held to the same retry contract; `dataSourceBehaviorScenarioNames` therefore grows by one entry. The report shape and all existing scenario names/facts are unchanged.
