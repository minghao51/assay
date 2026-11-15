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
 *     and only when the run's captured snapshot holds that node's contract
 *     (never a load that cannot happen, never a silent fallback to the live
 *     binding after a post-run re-bind);
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

/**
 * The contract a validate node is RE-BOUND to after a failed run — distinct
 * from the snapshot contract so the cross-link's resolution is observable.
 */
function reboundContract(): ContractV1 {
  const parsed = parseContract(CONTRACT_YAML.replace('name: r15-strict', 'name: r15-rebound'))
  if (!parsed.ok) throw new Error('component rebound contract fixture must parse')
  return parsed.contract
}

/** The contract the run STARTED with (captured at run start, never re-read). */
const SNAPSHOT_CONTRACT = loadedContract()

/** The node's live binding AFTER the user re-binds it post-run. */
const REBOUND_CONTRACT = reboundContract()

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
  // ug-9/R-15 (b): the contract the run started with. The panel must read
  // the cross-link's contract from HERE, not from the live bindings.
  contracts: { gate: SNAPSHOT_CONTRACT },
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
  contracts: { gate: SNAPSHOT_CONTRACT },
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
      gate: { kind: 'bound', contract: SNAPSHOT_CONTRACT },
    }
    const onInspectContract = vi.fn<(contract: ContractV1) => void>()
    const props = panelProps({ runState: GATED_RUN, contractBindings, onInspectContract })
    render(<PipelinePanel {...props} />)

    const crossLink = screen.getByTestId('pipeline-inspect-contract')
    expect(crossLink.textContent).toBe('Inspect this contract in Validation')
    expect(crossLink.getAttribute('data-node-id')).toBe('gate')
    // The value-free rule count copy is unchanged (ADR 0025).
    expect(screen.getByTestId('pipeline-run-gated-detail').textContent).toContain(
      'The contract failed 1 rule',
    )
    fireEvent.click(crossLink)
    expect(onInspectContract.mock.calls[0]?.[0]).toBe(SNAPSHOT_CONTRACT)
  })

  /**
   * ug-9/R-15 (b) regression pin (review round): the user re-binds the
   * validate node to a DIFFERENT contract after the run settled. The gated
   * detail still belongs to the OLD run, so the cross-link must load the
   * contract THAT RUN used — never the new live binding.
   */
  it('loads the run snapshot contract after the node is re-bound post-run', () => {
    const onInspectContract = vi.fn<(contract: ContractV1) => void>()
    const props = panelProps({
      runState: GATED_RUN,
      contractBindings: { gate: { kind: 'bound', contract: REBOUND_CONTRACT } },
      onInspectContract,
    })
    render(<PipelinePanel {...props} />)

    // The gated detail still describes the settled run...
    expect(screen.getByTestId('pipeline-run-gated-detail').textContent).toContain(
      'The contract failed 1 rule',
    )
    fireEvent.click(screen.getByTestId('pipeline-inspect-contract'))

    // ...so the loaded contract is the run's snapshot, not the new binding.
    expect(onInspectContract.mock.calls[0]?.[0]).toBe(SNAPSHOT_CONTRACT)
    expect(onInspectContract.mock.calls[0]?.[0]).not.toBe(REBOUND_CONTRACT)
  })

  it('offers the cross-link when the run stops at a publish gate whose validate gate failed', () => {
    const onInspectContract = vi.fn<(contract: ContractV1) => void>()
    const props = panelProps({
      runState: PUBLISH_BLOCKED_RUN,
      contractBindings: { gate: { kind: 'bound', contract: REBOUND_CONTRACT } },
      onInspectContract,
    })
    render(<PipelinePanel {...props} />)
    // The publish block is disclosed AND the failing validate is walkable.
    expect(screen.getByTestId('pipeline-run-gated-detail').textContent).toContain('gate')
    expect(screen.getByTestId('pipeline-run-gated-detail').textContent).toContain(
      'The contract failed 1 rule',
    )
    fireEvent.click(screen.getByTestId('pipeline-inspect-contract'))
    expect(onInspectContract.mock.calls[0]?.[0]).toBe(SNAPSHOT_CONTRACT)
  })

  it('never offers the cross-link without a run snapshot entry or without a failed gate', () => {
    // No snapshot entry for the failed node ⇒ nothing honest to load, no
    // control — NEVER a silent fallback to the node's current binding.
    const unbound = render(
      <PipelinePanel
        {...panelProps({
          runState: { ...GATED_RUN, contracts: {} },
          contractBindings: { gate: { kind: 'bound', contract: REBOUND_CONTRACT } },
        })}
      />,
    )
    expect(screen.queryByTestId('pipeline-inspect-contract')).toBeNull()
    unbound.unmount()

    // The run's snapshot is authoritative even when the live binding is gone:
    // the failed run still used a contract, so the cross-link stays offered.
    const snapshotOnly = render(
      <PipelinePanel {...panelProps({ runState: GATED_RUN, contractBindings: {} })} />,
    )
    expect(screen.getByTestId('pipeline-inspect-contract')).toBeTruthy()
    snapshotOnly.unmount()

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

describe('pipeline panel — EW-02D open-dataset scope sentence', () => {
  it('renders the exact scope sentence only while a dataset is open, with the bound/label set unchanged', () => {
    const { rerender } = render(<PipelinePanel {...panelProps({ openDatasetAvailable: false })} />)

    // No open dataset ⇒ no primary AND no scope sentence (the picker path
    // carries no new copy — EW-02D round-1 re-scope).
    expect(screen.queryByTestId('pipeline-open-dataset-scope')).toBeNull()
    expect(screen.queryByTestId('pipeline-bind-open-dataset')).toBeNull()

    // A dataset is open ⇒ the sentence renders VERBATIM (literal, no imported
    // constant), inside the existing primary's fragment.
    rerender(<PipelinePanel {...panelProps({ openDatasetAvailable: true })} />)
    const scope = screen.getByTestId('pipeline-open-dataset-scope')
    expect(scope.textContent).toBe(
      'Use the open dataset binds the opened file itself — staged grid edits and grid filters are not part of pipeline runs.',
    )

    // The RETAIN strings are byte-for-byte unchanged beside the new sentence.
    expect(screen.getByTestId('pipeline-bind-open-dataset').textContent).toBe(
      'Use the open dataset',
    )
    expect(screen.getByTestId('pipeline-bind').textContent).toBe('Choose a different file…')

    // A bound source still shows the honest bound marker (RETAIN) — the scope
    // sentence accompanies it without replacing it.
    const boundProps = panelProps({
      openDatasetAvailable: true,
      bindings: {
        customers: { kind: 'bound', fileName: 'noop', getFile: async () => new File([], 'noop') },
      },
    })
    rerender(<PipelinePanel {...boundProps} />)
    expect(screen.getByTestId('pipeline-source-bound').textContent).toBe('Dataset bound.')
    expect(screen.getByTestId('pipeline-open-dataset-scope').textContent).toBe(
      'Use the open dataset binds the opened file itself — staged grid edits and grid filters are not part of pipeline runs.',
    )
  })
})
