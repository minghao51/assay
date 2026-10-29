// SPDX-License-Identifier: AGPL-3.0-or-later

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { compilePipeline, isDataNode, parsePipeline, validatePipeline } from '@assay/pipeline'
import type { PipelineV1 } from '@assay/pipeline'
import { parseContract } from '@assay/contracts'
import type { ContractV1 } from '@assay/contracts'
import { PipelinePanel } from './PipelinePanel'
import type { PipelinePanelProps } from './PipelinePanel'
import type {
  ContractBindingState,
  PipelineFileState,
  PipelineRunOutcome,
  PipelineRunState,
} from './pipeline-state'

/**
 * ug-9 / R-15 component pins — the panel-side claims of the requirement:
 *
 * (a) a source node offers the primary "Use the open dataset" only while a
 *     dataset is open, a validate node offers "Use the loaded contract" only
 *     while Validation holds a parsed contract, and both secondaries carry
 *     the exact R-15 labels (the existing picker behaviour is untouched —
 *     the App-level pins prove the picker is never called);
 * (b) the failed validate gate offers "Inspect this contract in Validation",
 *     and only when the run's node actually has a bound contract (never a
 *     load that cannot happen);
 * (c) the first DCR mention is the export legend "Export the Dataset Change
 *     Request (DCR)", the purpose sentence renders verbatim, and no bare
 *     "DCR" precedes the expansion anywhere in the panel's rendered text.
 */

/** source → filter(SG) → validate → publish(requires validate). */
const GATED_PIPELINE_YAML = `version: 1
pipeline: r15_pin
nodes:
  customers:
    type: source
    source:
      kind: file
      path: ./customers.parquet
  gate:
    type: validate
    input: sg
    contract: contracts/strict.yaml
  out:
    type: publish
    input: sg
    requires: [ gate ]
  sg:
    type: transform
    inputs: [ customers ]
    operation:
      filter:
        predicates:
          - column: country
            operator: equals
            value: SG
`

const CONTRACT_YAML = `format: v1
name: r15-strict
version: 1
columns:
  - name: customer_id
    type: BIGINT
    required: true
  - name: country
    type: VARCHAR
    required: true
`

/**
 * R-15 (c) verbatim purpose sentence. Written out here (not imported) so a
 * copy regression in the panel cannot silently agree with itself.
 */
const DCR_PURPOSE_SENTENCE =
  'A Dataset Change Request packages a proposed dataset change for review — like a pull request for data.'

function dataSubgraph(pipeline: PipelineV1): PipelineV1 {
  return { ...pipeline, nodes: pipeline.nodes.filter((node) => isDataNode(node)) }
}

function loadedFileState(): Extract<PipelineFileState, { readonly kind: 'loaded' }> {
  const parsed = parsePipeline(GATED_PIPELINE_YAML)
  if (!parsed.ok) throw new Error('component fixture must parse')
  const validation = validatePipeline(parsed.pipeline)
  if (!validation.ok) throw new Error('component fixture must validate')
  const compiled = compilePipeline(dataSubgraph(parsed.pipeline))
  if (!compiled.ok) throw new Error('component fixture must compile')
  return {
    kind: 'loaded',
    pipeline: parsed.pipeline,
    plan: compiled.plan,
    order: validation.order,
  }
}

function loadedContract(): ContractV1 {
  const parsed = parseContract(CONTRACT_YAML)
  if (!parsed.ok) throw new Error('component contract fixture must parse')
  return parsed.contract
}

const FAILED_VALIDATE: PipelineRunOutcome = {
  nodeId: 'gate',
  relation: 'sg',
  rowCount: 0,
  materialization: 'gate',
  gate: { class: 'validate', input: 'sg', valid: false, violatedRules: 1 },
}

const GATED_RUN: PipelineRunState = {
  kind: 'gated',
  gatedAt: 'gate',
  gate: 'validation-failed',
  nextNodeId: 'out',
  outcomes: [FAILED_VALIDATE],
}

/**
 * The real gated FIXTURE posture: the run stops at the publish gate, while the
 * validate gate that failed sits in `outcomes`. The cross-link must be offered
 * here too (the user still cannot see which ruleIds failed).
 */
const PUBLISH_BLOCKED_RUN: PipelineRunState = {
  kind: 'gated',
  gatedAt: 'out',
  gate: 'publish-blocked',
  nextNodeId: null,
  outcomes: [
    FAILED_VALIDATE,
    {
      nodeId: 'out',
      relation: 'sg',
      rowCount: 2,
      materialization: 'gate',
      gate: { class: 'publish', input: 'sg', blockedGates: ['gate'] },
    },
  ],
}

const COMPLETED_RUN: PipelineRunState = {
  kind: 'completed',
  outcomes: [
    { nodeId: 'customers', relation: 'customers', rowCount: 5, materialization: 'view' },
    { nodeId: 'gate', relation: 'sg', rowCount: 2, materialization: 'gate' },
  ],
}

function panelProps(overrides: Partial<PipelinePanelProps> = {}): PipelinePanelProps {
  return {
    fileState: loadedFileState(),
    bindings: {},
    contractBindings: {},
    runState: { kind: 'idle' },
    preview: { kind: 'closed' },
    onOpenPipelineFile: vi.fn(),
    onBindSource: vi.fn(),
    onBindContract: vi.fn(),
    openDatasetAvailable: true,
    loadedContractAvailable: false,
    onBindOpenDataset: vi.fn(),
    onBindLoadedContract: vi.fn(),
    onInspectContract: vi.fn(),
    onRun: vi.fn(),
    onCancel: vi.fn(),
    onOpenPreview: vi.fn(),
    onClosePreview: vi.fn(),
    dcrExport: { kind: 'idle' },
    onExportDcr: vi.fn(),
    ...overrides,
  }
}

afterEach(() => {
  cleanup()
})

describe('pipeline panel — R-15 (a) binding continues the journey', () => {
  it('offers the source primary only while a dataset is open, with the exact R-15 labels', () => {
    const { rerender } = render(<PipelinePanel {...panelProps({ openDatasetAvailable: false })} />)

    // No open dataset ⇒ no primary; the existing picker stays as the secondary
    // under its R-15 label.
    expect(screen.queryByTestId('pipeline-bind-open-dataset')).toBeNull()
    expect(screen.getByTestId('pipeline-bind').textContent).toBe('Choose a different file…')

    // A dataset is open ⇒ the primary appears first and activates the
    // no-picker binder for THIS node.
    const props = panelProps({ openDatasetAvailable: true })
    rerender(<PipelinePanel {...props} />)
    const primary = screen.getByTestId('pipeline-bind-open-dataset')
    expect(primary.textContent).toBe('Use the open dataset')
    expect(primary.getAttribute('data-node-id')).toBe('customers')
    fireEvent.click(primary)
    expect(props.onBindOpenDataset).toHaveBeenCalledWith('customers')
    // The primary and the secondary are distinct gestures (the picker is
    // never silently reused for the App-held binding).
    expect(props.onBindSource).not.toHaveBeenCalled()

    // The secondary still routes to the existing picker path.
    fireEvent.click(screen.getByTestId('pipeline-bind'))
    expect(props.onBindSource).toHaveBeenCalledWith('customers')
  })

  it('offers the validate primary only while Validation holds a parsed contract', () => {
    const { rerender } = render(
      <PipelinePanel {...panelProps({ loadedContractAvailable: false })} />,
    )

    // No loaded contract ⇒ no primary; the existing picker keeps its R-15
    // label in both the unbound and the replace posture.
    expect(screen.queryByTestId('pipeline-bind-loaded-contract')).toBeNull()
    expect(screen.getByTestId('pipeline-bind-contract').textContent).toBe(
      'Choose a different contract…',
    )

    // A loaded contract ⇒ the primary appears and binds the loaded contract.
    const props = panelProps({ loadedContractAvailable: true })
    rerender(<PipelinePanel {...props} />)
    const primary = screen.getByTestId('pipeline-bind-loaded-contract')
    expect(primary.textContent).toBe('Use the loaded contract')
    expect(primary.getAttribute('data-node-id')).toBe('gate')
    fireEvent.click(primary)
    expect(props.onBindLoadedContract).toHaveBeenCalledWith('gate')
    expect(props.onBindContract).not.toHaveBeenCalled()
  })

  it('keeps the secondary label honest once a binding exists (no "choose" copy regression)', () => {
    const contractBindings: Readonly<Record<string, ContractBindingState>> = {
      gate: { kind: 'bound', contract: loadedContract() },
    }
    render(
      <PipelinePanel
        {...panelProps({ contractBindings, loadedContractAvailable: true, bindings: {} })}
      />,
    )
    expect(screen.getByTestId('pipeline-contract-bound')).toBeTruthy()
    expect(screen.getByTestId('pipeline-bind-contract').textContent).toBe(
      'Choose a different contract…',
    )
    expect(screen.getByTestId('pipeline-bind-loaded-contract').textContent).toBe(
      'Use the loaded contract',
    )
  })
})

describe('pipeline panel — R-15 (b) gate-failure cross-link', () => {
  it('offers "Inspect this contract in Validation" for a failed validate gate', () => {
    const contractBindings: Readonly<Record<string, ContractBindingState>> = {
      gate: { kind: 'bound', contract: loadedContract() },
    }
    const props = panelProps({ runState: GATED_RUN, contractBindings })
    render(<PipelinePanel {...props} />)

    const crossLink = screen.getByTestId('pipeline-inspect-contract')
    expect(crossLink.textContent).toBe('Inspect this contract in Validation')
    expect(crossLink.getAttribute('data-node-id')).toBe('gate')
    // The value-free rule count copy is unchanged (ADR 0025).
    expect(screen.getByTestId('pipeline-run-gated-detail').textContent).toContain(
      'The contract failed 1 rule',
    )
    fireEvent.click(crossLink)
    expect(props.onInspectContract).toHaveBeenCalledWith('gate')
  })

  it('offers the cross-link when the run stops at a publish gate whose validate gate failed', () => {
    const props = panelProps({
      runState: PUBLISH_BLOCKED_RUN,
      contractBindings: { gate: { kind: 'bound', contract: loadedContract() } },
    })
    render(<PipelinePanel {...props} />)
    // The publish block is disclosed AND the failing validate is walkable.
    expect(screen.getByTestId('pipeline-run-gated-detail').textContent).toContain('gate')
    expect(screen.getByTestId('pipeline-run-gated-detail').textContent).toContain(
      'The contract failed 1 rule',
    )
    fireEvent.click(screen.getByTestId('pipeline-inspect-contract'))
    expect(props.onInspectContract).toHaveBeenCalledWith('gate')
  })

  it('never offers the cross-link without a bound contract or without a failed gate', () => {
    // No bound contract for the failed node ⇒ nothing to load, no control.
    const unbound = render(<PipelinePanel {...panelProps({ runState: GATED_RUN })} />)
    expect(screen.queryByTestId('pipeline-inspect-contract')).toBeNull()
    unbound.unmount()

    // A completed run has no failed gate.
    render(
      <PipelinePanel
        {...panelProps({
          runState: COMPLETED_RUN,
          contractBindings: { gate: { kind: 'bound', contract: loadedContract() } },
        })}
      />,
    )
    expect(screen.queryByTestId('pipeline-inspect-contract')).toBeNull()
  })
})

describe('pipeline panel — R-15 (c) DCR expansion', () => {
  it('expands the first DCR mention and pins no bare DCR before it', () => {
    render(<PipelinePanel {...panelProps({ runState: COMPLETED_RUN })} />)

    const panel = screen.getByTestId('pipeline-panel')
    const text = panel.textContent ?? ''

    // The purpose sentence renders verbatim.
    expect(text).toContain(DCR_PURPOSE_SENTENCE)

    // The export legend is the expansion, verbatim.
    const legend = screen.getByTestId('pipeline-dcr-export').querySelector('legend')
    expect(legend?.textContent).toBe('Export the Dataset Change Request (DCR)')

    // No bare "DCR" precedes the expansion anywhere in the panel's text: the
    // FIRST occurrence of the token starts inside the expansion itself.
    const expansion = 'Dataset Change Request (DCR)'
    const expansionIndex = text.indexOf(expansion)
    expect(expansionIndex).toBeGreaterThanOrEqual(0)
    expect(text.indexOf('DCR')).toBe(expansionIndex + 'Dataset Change Request ('.length)
  })
})
