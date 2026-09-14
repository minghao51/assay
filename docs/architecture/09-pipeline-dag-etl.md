# Data Workbench Pipeline, DAG, and ETL Architecture

## 1. Purpose

Data Workbench should evolve beyond file inspection into a visual, governed pipeline environment that supports both technical and non-technical users.

The pipeline layer should make it easy to ingest, transform, validate, compare, publish, and govern datasets without requiring users to adopt a proprietary execution language.

The product should not attempt to rebuild dbt, SQLMesh, Dagster, Airflow, or dlt. Data Workbench should own the user-facing pipeline model and experience, while reusing established tools where they are strongest.

## 2. Guiding Principle

> Own the pipeline model and UX. Reuse SQL and existing transformation/orchestration ecosystems.

Separate five concerns:

1. logical pipeline,
2. transformation execution,
3. orchestration,
4. ingestion,
5. governance.

Do not collapse them into one runtime.

## 3. Conceptual Architecture

```text
                Visual Pipeline Builder
                         |
                    SQL / DAG View
                         |
                         v
                  Pipeline IR / AST
                         |
       +-----------------+-------------------+
       |                 |                   |
     Lineage          Contracts        Materialization
       |                 |                   |
       +-----------------+-------------------+
                         |
                         v
                   Pipeline Planner
                         |
             dependency / impact plan
                         |
        +----------------+-------------------+
        |                                    |
     Local / Dev                         Production
        |                                    |
    DuckDB-WASM                  dbt / SQLMesh / native SQL
                                             |
                                     orchestrator if needed
                                             |
                                          Dagster
```

Ingestion is orthogonal:

```text
 File       Database        API       Object Store
  |             |            |             |
  +-------------+------------+-------------+
                |
            Source Node
                |
      browser adapter / connector / dlt
```

## 4. SQL-First Transformation Model

SQL is the canonical execution target for relational transformations such as:

- filter,
- select/projection,
- rename,
- cast,
- join,
- aggregate,
- deduplicate,
- window operations,
- pivot/unpivot,
- nested extraction where supported.

A visual operation must be inspectable as SQL.

```text
Customers
   |
Filter country = "SG"
   |
Cast income -> DECIMAL
   |
Join Policies
   |
Aggregate customer_id
```

can compile to:

```sql
SELECT
    c.customer_id,
    SUM(p.premium) AS total_premium
FROM customers c
LEFT JOIN policies p
    USING (customer_id)
WHERE c.country = 'SG'
GROUP BY c.customer_id;
```

SQL is preferred because it is portable, inspectable, versionable, composable, and compatible with DuckDB, databases, warehouses, dbt, and SQLMesh.

## 5. Pipeline IR

SQL text itself is not the complete pipeline source of truth. Data Workbench owns a portable Pipeline IR.

Example:

```yaml
version: 1
pipeline: customer_portfolio

nodes:
  customers:
    type: source
    source:
      kind: file
      path: ./customers.parquet

  sg_customers:
    type: transform
    inputs: [customers]
    operation:
      filter:
        expression: country = 'SG'

  policies:
    type: source
    source:
      kind: file
      path: ./policies.parquet

  customer_policies:
    type: transform
    inputs: [sg_customers, policies]
    operation:
      join:
        left: sg_customers
        right: policies
        on: [customer_id]

  portfolio:
    type: sql
    inputs: [customer_policies]
    sql: |
      SELECT customer_id, SUM(premium) AS total_premium
      FROM customer_policies
      GROUP BY customer_id

  quality:
    type: validate
    input: portfolio
    contract: contracts/portfolio.yaml

  output:
    type: publish
    input: portfolio
    requires: [quality]
```

The IR must remain declarative, serializable, engine-neutral, human-readable, Git-friendly, and usable by Web, VS Code, CLI, and enterprise services.

## 6. Node Types

Initial node types:

- **Source** — local file, directory dataset, Hugging Face dataset, database table, object-store path, or connector-backed input.
- **Transform** — structured visual operations such as filter, cast, join, aggregate, flatten, explode, and deduplicate.
- **SQL** — arbitrary supported SQL.
- **Validate** — runs a Data Workbench contract or validation rule set.
- **Diff** — compares current output with another dataset/version.
- **Publish** — creates a file output, local DatasetVersion, governed DatasetVersion, or warehouse/table output.

Future node types may include AI/ML evaluation, scoring, policy gates, approvals, feature computation, and notifications.

## 7. Visual and SQL Editing

Visual mode serves non-technical users and common operations. SQL mode preserves full expressiveness.

```text
Visual -> SQL
```

is guaranteed for supported visual operations.

```text
arbitrary SQL -> visual
```

is best-effort only. SQL that cannot safely map back remains a `Custom SQL` node.

This prevents the visual builder from becoming a restrictive proprietary DSL.

## 8. Materialization Model

Nodes may declare a logical materialization mode:

- `ephemeral`
- `view`
- `table`
- `cache`
- `incremental`
- `export`
- `publish`

Local mapping:

| Logical mode | DuckDB/local behavior    |
| ------------ | ------------------------ |
| ephemeral    | CTE / nested SQL         |
| view         | temporary view           |
| table        | DuckDB table             |
| cache        | OPFS-backed intermediate |
| incremental  | future local strategy    |
| export       | Parquet/JSONL/CSV output |
| publish      | local DatasetVersion     |

Remote backends map the same intent into warehouse/database-native semantics.

## 9. Local Runner

The first runner should remain intentionally small. It should:

1. validate the DAG,
2. topologically sort nodes,
3. register sources,
4. compile structured transforms into SQL,
5. create temporary views/tables,
6. execute validation nodes,
7. export or publish outputs.

The local runner is not a general-purpose scheduler.

## 10. dbt Integration

dbt is a first-class compatibility target, not a core browser dependency.

Future support should include:

- inspect/import dbt projects,
- visualize models and sources,
- understand lineage,
- map compatible tests/contracts,
- export compatible models and YAML,
- optionally invoke dbt in suitable environments.

Unsupported Jinja/macros should be preserved rather than silently rewritten.

## 11. SQLMesh Integration

SQLMesh is both an architectural reference and a potential execution adapter.

Concepts worth borrowing include:

- environments,
- plans,
- model changes,
- audits,
- table diff,
- impact analysis,
- incremental models.

Data Workbench's Dataset Change Request remains the product-owned review primitive.

## 12. Ingestion and dlt

Ingestion remains separate from transformation.

Simple local sources are handled directly through DataSource adapters and DuckDB registration.

Complex API/SaaS/database extraction may use connectors or external ingestion engines such as dlt rather than rebuilding pagination, incremental loading, and schema evolution.

## 13. Orchestration and Dagster

Production orchestration is introduced only when workflows require schedules, retries, backfills, sensors, event triggers, cross-system tasks, or notifications.

```text
Pipeline
   |
   +-- LocalRunner
   +-- dbt
   +-- SQLMesh
   +-- Dagster
```

The Pipeline IR must not depend directly on Dagster-specific concepts.

## 14. Non-Technical User Experience

The visual builder should expose business operations rather than infrastructure details.

```text
[Customers] -> [Clean] ----+
                           +--> [Join] -> [Validate] -> [Publish]
[Policies] ----------------+
```

Each transform should expose:

- form-based configuration,
- generated SQL,
- preview,
- schema impact,
- diff.

Errors should be actionable. For example:

```text
The Join step cannot run.

customer_id is text in Customers but integer in Policies.

Suggested fix:
Convert Policies.customer_id to text.
```

## 15. Pipeline Preview

Every transform node should support preview showing:

- sample output rows,
- schema changes,
- row-count estimate where possible,
- quality impact,
- generated SQL,
- scan/cost estimate where available.

Preview is essential for non-technical users and for safe AI-assisted authoring.

## 16. Lineage

Support progressively richer lineage:

1. dataset lineage,
2. pipeline-node lineage,
3. column lineage later.

Example:

```text
customers + policies -> customer_portfolio
```

and eventually:

```text
policies.premium -> portfolio.total_premium
```

## 17. DAG Validation

Before execution, validate that:

- the graph is acyclic,
- required inputs exist,
- node IDs are unique,
- references resolve,
- schemas are compatible where known,
- publish configuration is valid,
- required validation gates exist.

## 18. Incremental Processing

Incremental execution is planned but not required for the initial pipeline implementation.

Potential strategies:

- timestamp watermark,
- monotonic ID,
- source snapshot/version,
- partition-based processing,
- merge/upsert.

Incremental semantics belong to node/materialization configuration, not the visual renderer.

## 19. Data Quality as a DAG Primitive

Validation is visible in the data flow:

```text
Source -> Transform -> Validate -> Publish
```

Publish may be gated by quality, privacy, contract, and governance checks.

## 20. Dataset Change Request Integration

Pipeline execution can generate a candidate DatasetVersion, which then creates a Dataset Change Request.

```text
Pipeline run
    |
    v
Candidate DatasetVersion
    |
    v
Dataset Change Request
    |
    +-- schema diff
    +-- profile diff
    +-- quality
    +-- drift
    +-- privacy
    +-- lineage
    |
    v
Review / Publish
```

This links ETL directly to governance.

## 21. AI-Assisted Pipeline Building

AI may propose:

- SQL,
- joins,
- schema mappings,
- validation rules,
- repairs,
- documentation,
- explanations of failures.

The existing principle remains:

> AI proposes; deterministic systems execute.

AI output must become SQL, a structured pipeline operation, a contract, or another reviewable artifact before execution.

## 22. Production Execution Boundary

The same logical pipeline should remain portable:

```text
Pipeline IR
    |
    +-- browser/local -> DuckDB-WASM
    +-- CLI           -> DuckDB/native execution
    +-- analytics     -> dbt / SQLMesh
    +-- enterprise    -> orchestrator + remote engines
```

## 23. What Data Workbench Owns

Own:

- visual DAG,
- Pipeline IR,
- preview UX,
- lineage model,
- validation integration,
- dataset-version integration,
- Dataset Change Request integration,
- SQL compilation for standard transformations.

Do not initially own:

- distributed scheduling,
- full connector ecosystem,
- warehouse optimizer,
- custom SQL engine,
- generalized workflow runtime.

## 24. Implementation Sequence

### Pipeline Phase 1 — IR and Local Runner

- Pipeline IR,
- source nodes,
- SQL nodes,
- filter/select/cast/join/aggregate nodes,
- local DuckDB runner,
- basic DAG UI.

### Pipeline Phase 2 — Quality and Publish

- validation nodes,
- publish nodes,
- preview,
- generated SQL,
- materialization,
- lineage.

### Pipeline Phase 3 — Ecosystem Compatibility

- SQL import,
- dbt project inspection,
- dbt export,
- DCR integration.

### Pipeline Phase 4 — Planning and Incremental Models

- SQLMesh adapter,
- environments/plans,
- incremental semantics.

### Pipeline Phase 5 — Ingestion and Orchestration

Only when validated by user needs:

- dlt-backed ingestion,
- Dagster adapter,
- scheduling/backfill UI.

## 25. Key Product Principle

The target is:

> Informatica-style visual accessibility with developer-grade transparency and portability.

Users should never be trapped inside a proprietary visual workflow. Meaningful pipeline artifacts should remain inspectable, versionable, testable, and exportable.
