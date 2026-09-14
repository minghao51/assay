# Diff fixtures

Canonical dataset pairs for row/schema diff tests.

Current pairs:

- `../csv/customers.csv` ↔ `../csv/customers-v2.csv`:
  row 3 income changed (`null` → `45000`), row 5 removed, row 6 added.

Generated Parquet pairs arrive with the fixture generator (decision D3).
