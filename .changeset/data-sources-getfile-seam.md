---
'@assay/data-sources': patch
---

feat(m1-4): expose `BrowserFileSource.getFile()` publicly so engines can reach the resolved `File` through a structural seam without a package dependency in either direction. It shares the instance's one-shot lazy snapshot (`open()`/`metadata()` observe the same `File`) and only resolves the reference — no dataset bytes are read here (ADR 0001/0025). Stays behind the `./browser` subpath; the root entry remains environment-neutral.
