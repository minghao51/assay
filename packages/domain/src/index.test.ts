import { describe, expectTypeOf, it } from 'vitest'
import type {
  AccessPolicy,
  Contract,
  DataProduct,
  Dataset,
  DatasetChangeRequest,
  DatasetVersion,
  EncryptionPolicy,
  Lineage,
  Owner,
  PhysicalAsset,
  QualityPolicy,
  Review,
} from './index'

describe('domain model types (docs/architecture/01-architecture.md §5)', () => {
  it('declares the core aggregates without any runtime dependencies', () => {
    expectTypeOf<DataProduct>().not.toBeAny()
    expectTypeOf<Dataset>().not.toBeAny()
    expectTypeOf<DatasetVersion>().not.toBeAny()
    expectTypeOf<PhysicalAsset>().not.toBeAny()
    expectTypeOf<Contract>().not.toBeAny()
    expectTypeOf<QualityPolicy>().not.toBeAny()
    expectTypeOf<AccessPolicy>().not.toBeAny()
    expectTypeOf<EncryptionPolicy>().not.toBeAny()
    expectTypeOf<Owner>().not.toBeAny()
    expectTypeOf<Lineage>().not.toBeAny()
    expectTypeOf<Review>().not.toBeAny()
    expectTypeOf<DatasetChangeRequest>().not.toBeAny()
  })

  it('keeps dataset version identity logical (ADR 0011)', () => {
    expectTypeOf<DatasetVersion['assetIds']>().toEqualTypeOf<string[]>()
    expectTypeOf<DatasetVersion['schemaFingerprint']>().toMatchTypeOf<
      { algorithm: string; value: string } | undefined
    >()
  })

  it('models DCR status as the review lifecycle (ADR 0014)', () => {
    expectTypeOf<DatasetChangeRequest['status']>().toEqualTypeOf<
      'draft' | 'open' | 'approved' | 'rejected'
    >()
  })
})
