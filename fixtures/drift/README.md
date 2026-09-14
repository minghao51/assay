# Drift fixtures

Pairs of datasets with known distribution drift for testing the distribution
diff methods (PSI, Jensen–Shannon, KS — see `docs/product/01-features.md` §4.4).

To be generated alongside the Parquet generator (decision D3). The canonical
schema-level diff pair today is `../csv/customers.csv` vs
`../csv/customers-v2.csv` (one changed row, one added, one removed).
