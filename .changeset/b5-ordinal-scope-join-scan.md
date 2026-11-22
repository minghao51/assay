---
'@assay/diff': patch
---

fix(b5): the structural ordinal anti-regression scan now flags every same-scope row-set clause, not only a sibling `WHERE`. A bare same-`SELECT` `JOIN … ON` filter (the recorded blind spot) removes rows before `row_number()` numbers them, exactly like the round-1 post-filter defect. `scanOrdinalScopes` now reports `HAVING`, `QUALIFY`, `GROUP BY` and the whole `JOIN` family (`LEFT`/`RIGHT`/`FULL [OUTER]`, `INNER`, `CROSS`, `NATURAL`, `SEMI`/`ANTI`, `POSITIONAL`, `ASOF`) at the ordinal's own indent, with a hostile-shape test per clause and a no-false-positive case for a nested derived table. Generated plan SQL is unchanged; this is a test-only hardening of the pin that guards it.
