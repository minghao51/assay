import { test, expect } from '@playwright/test'

// ar-6 red-run demo (deliberate, temporary): proves the CI retry budget
// (retries: 2) and the failure-artifact upload (trace on-first-retry, video
// retain-on-failure) actually fire. This commit is reverted before merge.
test('DELIBERATE RED: artifact upload + retry budget demo', async () => {
  expect(1).toBe(2)
})
