/**
 * @dataworkbench/domain — pure domain entities and types.
 *
 * The domain package is deliberately portable: no React, no browser APIs,
 * no engine dependencies (docs/engineering/05-repository-structure.md §3,
 * enforced by lint). Types below are the M0 scaffold of the domain model in
 * docs/architecture/02-architecture.md §5 and ADR 0004/0011; shapes are
 * expected to evolve through milestones M4–M9.
 */

/** Security classification labels (docs/product/01-features.md §10.1). */
export type Classification = 'public' | 'internal' | 'confidential' | 'restricted'

export interface Owner {
  id: string
  name: string
  kind: 'user' | 'group' | 'service'
}

/**
 * A physical representation of a dataset version (ADR 0011).
 * kind examples: 'local-file' | 's3-object' | 'adls-path' | 'hf-split' |
 * 'snowflake-table' | 'databricks-table'.
 */
export interface PhysicalAsset {
  id: string
  kind: string
  uri: string
  format: 'parquet' | 'jsonl' | 'json' | 'csv' | 'arrow' | 'feather' | (string & {})
  partitions?: string[]
}

export interface SchemaFingerprint {
  algorithm: string
  value: string
}

/** Immutable dataset version (ADR 0011: identity is logical, not file-based). */
export interface DatasetVersion {
  id: string
  datasetId: string
  schemaFingerprint?: SchemaFingerprint
  assetIds: string[]
  provenance?: Provenance
}

export interface Provenance {
  createdAt: string
  transformationRecipe?: string
  parentVersionIds?: string[]
}

export interface Dataset {
  id: string
  dataProductId?: string
  name: string
  currentVersionId?: string
  classification?: Classification
}

/** Native contract (ADR 0013 — format to be specified in M5). */
export interface Contract {
  id: string
  datasetId: string
  version: number
  rules: unknown[]
}

export interface QualityPolicy {
  id: string
  datasetId: string
  rules: unknown[]
}

export interface AccessPolicy {
  id: string
  datasetId: string
  roles: string[]
}

export interface EncryptionPolicy {
  id: string
  datasetId: string
  kmsProvider?: string
}

export interface Lineage {
  datasetVersionId: string
  inputVersionIds: string[]
}

export interface Review {
  id: string
  datasetChangeRequestId: string
  reviewer: string
  decision: 'approved' | 'rejected' | 'changes-requested'
}

/**
 * The dataset equivalent of a pull request (ADR 0014).
 * Generated locally from M9; reviewed in hosted workspaces from M10.
 */
export interface DatasetChangeRequest {
  id: string
  baseVersionId: string
  candidateVersionId: string
  summary: DcrSummary
  status: 'draft' | 'open' | 'approved' | 'rejected'
}

export interface DcrSummary {
  rowsAdded: number
  rowsRemoved: number
  rowsChanged: number
  schemaChanges: string[]
  qualityFindings: string[]
}

/** The governed product aggregate (ADR 0004) — Phase 6 territory. */
export interface DataProduct {
  id: string
  name: string
  owner?: Owner
  datasets: Dataset[]
  contracts: Contract[]
}
