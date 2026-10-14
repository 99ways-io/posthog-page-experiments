import { expect, test } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const posthogBundle = path.join(repositoryRoot, 'tests/fixtures/posthog.bundle.js')
const experimentBundle = path.join(repositoryRoot, 'dist/posthog-page-experiments.min.js')

test('the shipped browser bundle works with an initialized posthog-js client', async ({ page }) => {
  await page.setContent('<h1 class="hero-title">Original headline</h1>')
  await page.addScriptTag({ path: posthogBundle })
  await page.addScriptTag({ path: experimentBundle })

  const result = await page.evaluate(() => window.runExperiment('browser-bundle-test', {
    isEligible: () => document.querySelector('.hero-title') !== null,
    variants: {
      control: [],
      test: [
        {
          selector: '.hero-title',
          updates: { innerText: 'Test headline' },
        },
      ],
    },
  }))

  expect(result).toBe('test')
  await expect(page.locator('.hero-title')).toHaveText('Test headline')
})

test('the shipped browser bundle logs an assignment summary from posthog-js', async ({ page }) => {
  const summaries: unknown[][] = []
  page.on('console', async (message) => {
    if (message.type() !== 'info' || !message.text().startsWith('[Experiment:summary-bundle-test]')) return
    summaries.push(await Promise.all(message.args().map((arg) => arg.jsonValue())))
  })
  await page.setContent('<h1 class="hero-title">Original headline</h1>')
  await page.addScriptTag({ path: posthogBundle })
  await page.addScriptTag({ path: experimentBundle })

  await page.evaluate(() => window.runExperiment('summary-bundle-test', {
    variants: { control: [], test: [] },
  }))

  await expect.poll(() => summaries.length).toBe(1)
  const [headline, assignment] = summaries[0] as [string, Record<string, unknown>]
  expect(headline).toBe("[Experiment:summary-bundle-test] Variant 'control' (from posthog).")
  expect(assignment).toMatchObject({
    featureFlag: 'summary-bundle-test',
    variant: 'control',
    source: 'posthog',
    flagValue: null,
    distinctId: 'browser-test-user',
  })
  expect(String(assignment.note)).toContain('PostHog returned no variant')
})

test('the shipped browser bundle supports URL QA without PostHog', async ({ page }) => {
  await page.route('https://example.test/**', async (route) => {
    await route.fulfill({
      contentType: 'text/html',
      body: '<p class="offer">Original offer</p>',
    })
  })
  await page.goto('https://example.test/?qa-demo=test')
  await page.addScriptTag({ path: experimentBundle })

  const result = await page.evaluate(() => window.runExperiment('qa-demo', {
    variants: {
      control: [],
      test: [{ selector: '.offer', updates: { innerText: 'QA override works' } }],
    },
  }))

  expect(result).toBe('test')
  await expect(page.locator('.offer')).toHaveText('QA override works')
})
