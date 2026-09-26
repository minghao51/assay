---
'@assay/engine-duckdb': patch
---

Wire-gate hardening: rule-less validation plans must carry the exact compiler-shaped empty summary (belt 1 rejects smuggled relation-free SQL), and the diff reserved-column check is identifier-aware so string-literal mentions cannot spoof it and reserved-name failures land at the gate.
