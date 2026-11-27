// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Tests for `scripts/build-collector.mjs` — specifically the endpoint plumbing the
 * live probe depends on.
 *
 * Regression-first: on 2026-11-27 `--probe <url>` reported `8/8 fetch failed` against
 * a deployment that answered every contract request correctly (measured with curl:
 * GET 405, and 8/8 green once fixed). Cause: `defineProbes` addressed its requests to
 * a hardcoded `https://collector.example.invalid/…` placeholder and `probeLive`
 * handed `fetch` straight through, so the URL the operator supplied was only ever
 * printed, never dialled. The acceptance step was therefore guaranteed red against
 * any endpoint — healthy or not — while looking like an unhealthy deployment.
 *
 * These tests assert the plumbing, not the deployment: that every probe request
 * carries the endpoint it was given, that a mismatched target names itself, and that
 * omitting the endpoint is refused rather than silently defaulting. Whether a live
 * endpoint answers is the workflow's own `--probe` step.
 */
import { describe, expect, it } from 'vitest'
import { defineProbes, guardTarget } from './build-collector.mjs'

/** Only `MAX_REQUEST_BYTES` is read at definition time; the rest is asserted lazily. */
const stubModule = { MAX_REQUEST_BYTES: 1024 }

/** A Response-shaped stub: probes assert on status/body, we only record targets. */
const stubResponse = { status: 200, text: async () => '{}', headers: { get: () => null } }

const endpoint = 'https://assay-dataworkbench.netlify.app/.netlify/functions/collect'

describe('guardTarget', () => {
  it('passes a request addressed to the endpoint under test', () => {
    const request = { url: endpoint }
    expect(guardTarget(request, endpoint)).toBe(request)
  })

  it('names both URLs when a probe is addressed elsewhere', () => {
    const request = { url: 'https://collector.example.invalid/.netlify/functions/collect' }
    expect(() => guardTarget(request, endpoint)).toThrow(/collector\.example\.invalid/)
    expect(() => guardTarget(request, endpoint)).toThrow(/assay-dataworkbench/)
  })
})

describe('defineProbes endpoint plumbing', () => {
  it('addresses every probe to the endpoint it was given', async () => {
    const targets = []
    const probes = defineProbes(
      stubModule,
      (request) => {
        targets.push(request.url)
        return Promise.resolve(stubResponse)
      },
      endpoint,
    )
    expect(probes.length).toBeGreaterThan(0)
    for (const probe of probes) {
      // Assertions inside the probe are irrelevant here — only the target is.
      await probe.fn().catch(() => undefined)
    }
    expect(targets.length).toBe(probes.length)
    for (const target of targets) expect(target).toBe(endpoint)
    // The defect in one line: nothing may still point at the placeholder host.
    expect(targets.some((target) => target.includes('.invalid'))).toBe(false)
  })

  it('refuses to define probes without an endpoint', () => {
    expect(() => defineProbes(stubModule, () => Promise.resolve(stubResponse))).toThrow(/endpoint/i)
    expect(() => defineProbes(stubModule, () => Promise.resolve(stubResponse), '')).toThrow(
      /endpoint/i,
    )
  })
})
