import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const posthogBundle = path.join(repositoryRoot, 'tests/fixtures/posthog.bundle.js')
const experimentBundle = path.join(repositoryRoot, 'dist/posthog-page-experiments.min.js')

const flag = 'consent-test'
const flagsResponse = JSON.stringify({
  flags: {
    [flag]: { key: flag, enabled: true, variant: 'test', reason: { code: 'condition_match' }, metadata: { id: 1, version: 1 } },
  },
  featureFlags: { [flag]: 'test' },
  featureFlagPayloads: {},
  errorsWhileComputingFlags: false,
})

declare global {
  interface Window {
    experiment: Promise<string | null>
    exposures: unknown[]
    grant(): void
    withdraw(): void
  }
}

// A page that loads posthog-js in the head and the experiment in the footer. With `gated`, PostHog
// starts opted out and eligibility waits for consent, like a site behind a consent banner.
function shopPage(gated: boolean): string {
  return `<!doctype html>
<html>
<head>
<script>
  window.exposures = []
  window.posthogTestConfig = {
    api_host: 'https://posthog.test',
    bootstrap: {},
    persistence: 'localStorage+cookie',
    ${gated ? 'opt_out_capturing_by_default: true, opt_out_persistence_by_default: true,' : ''}
    // Headless Chromium would otherwise be filtered out as a bot.
    opt_out_useragent_filter: true,
    // Events reach before_send only while PostHog is capturing.
    before_send: (event) => {
      if (event && event.event === '$feature_flag_called') window.exposures.push(event.properties.$feature_flag_response)
      return null
    },
  }
  window.analyticsConsent = new Promise((resolve) => { window.allowAnalytics = resolve })
  window.grant = () => {
    window.posthog.opt_in_capturing({ captureEventName: false })
    window.allowAnalytics()
  }
  window.withdraw = () => window.posthog.opt_out_capturing()
</script>
<script src="/posthog.js"></script>
<script>if (window.posthog.has_opted_in_capturing()) window.allowAnalytics()</script>
</head>
<body>
<h1 class="hero-title">Original headline</h1>
<script src="/experiments.js"></script>
<script>
  window.experiment = window.runExperiment('${flag}', {
    isEligible: async () => {
      // A URL preview reads no flag, so only measured visits wait for consent.
      if (${gated} && !new URLSearchParams(location.search).has('${flag}')) await window.analyticsConsent
      return document.querySelector('.hero-title') !== null
    },
    variants: {
      control: [],
      test: [{ selector: '.hero-title', updates: { innerText: 'Test headline' } }],
    },
  })
</script>
</body>
</html>`
}

// Serves the page and holds PostHog's feature-flag response until `releaseFlags()` is called.
async function openShop(page: Page, { gated = true, search = '' } = {}) {
  let releaseFlags!: () => void
  const flagsReleased = new Promise<void>((resolve) => { releaseFlags = resolve })

  await page.route('https://posthog.test/**', async (route) => {
    if (new URL(route.request().url()).pathname.startsWith('/flags')) {
      await flagsReleased
      await route.fulfill({ contentType: 'application/json', body: flagsResponse })
      return
    }
    await route.fulfill({ contentType: 'application/json', body: '{}' })
  })
  await page.route('https://shop.test/**', async (route) => {
    const { pathname } = new URL(route.request().url())
    if (pathname === '/posthog.js') return route.fulfill({ path: posthogBundle, contentType: 'text/javascript' })
    if (pathname === '/experiments.js') return route.fulfill({ path: experimentBundle, contentType: 'text/javascript' })
    return route.fulfill({ contentType: 'text/html', body: shopPage(gated) })
  })
  await page.goto(`https://shop.test/${search}`)

  return { releaseFlags }
}

test('assigns and records the exposure when consent is granted before flags arrive', async ({ page }) => {
  const { releaseFlags } = await openShop(page)

  await page.evaluate(() => window.grant())
  releaseFlags()

  expect(await page.evaluate(() => window.experiment)).toBe('test')
  await expect(page.locator('.hero-title')).toHaveText('Test headline')
  expect(await page.evaluate(() => window.exposures)).toEqual(['test'])
})

test('previews a URL variant without consent and without reading the flag', async ({ page }) => {
  await openShop(page, { search: `?${flag}=test` })

  expect(await page.evaluate(() => window.experiment)).toBe('test')
  await expect(page.locator('.hero-title')).toHaveText('Test headline')
  expect(await page.evaluate(() => window.posthog?.is_capturing?.())).toBe(false)
  expect(await page.evaluate(() => window.exposures)).toEqual([])
})

test('keeps the default when consent is withdrawn before flags arrive', async ({ page }) => {
  const { releaseFlags } = await openShop(page)

  await page.evaluate(() => window.grant())
  await page.evaluate(() => window.withdraw())
  releaseFlags()

  expect(await page.evaluate(() => window.experiment)).toBe('control')
  await expect(page.locator('.hero-title')).toHaveText('Original headline')
  expect(await page.evaluate(() => window.exposures)).toEqual([])
})

test('records the exposure on the next page view when consent is granted again after the fallback', async ({ page }) => {
  const { releaseFlags } = await openShop(page)

  await page.evaluate(() => window.grant())
  await page.evaluate(() => window.withdraw())
  releaseFlags()
  expect(await page.evaluate(() => window.experiment)).toBe('control')

  await page.evaluate(() => window.grant())
  await expect(page.locator('.hero-title')).toHaveText('Original headline')
  expect(await page.evaluate(() => window.exposures)).toEqual([])

  await page.reload()
  expect(await page.evaluate(() => window.experiment)).toBe('test')
  await expect(page.locator('.hero-title')).toHaveText('Test headline')
  expect(await page.evaluate(() => window.exposures)).toEqual(['test'])
})

test('assigns when consent is withdrawn and granted again before flags arrive', async ({ page }) => {
  const { releaseFlags } = await openShop(page)

  await page.evaluate(() => window.grant())
  await page.evaluate(() => window.withdraw())
  await page.evaluate(() => window.grant())
  releaseFlags()

  expect(await page.evaluate(() => window.experiment)).toBe('test')
  await expect(page.locator('.hero-title')).toHaveText('Test headline')
  expect(await page.evaluate(() => window.exposures)).toEqual(['test'])
})

test('assigns and records the exposure on a site without consent gating', async ({ page }) => {
  const { releaseFlags } = await openShop(page, { gated: false })

  releaseFlags()

  expect(await page.evaluate(() => window.experiment)).toBe('test')
  await expect(page.locator('.hero-title')).toHaveText('Test headline')
  expect(await page.evaluate(() => window.exposures)).toEqual(['test'])
})
