import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const experimentBundle = path.join(repositoryRoot, 'dist/posthog-page-experiments.min.js')
const posthogArray = path.join(repositoryRoot, 'node_modules/posthog-js/dist/array.js')

const flag = 'consent-switch-test'
const runnerUrl = 'https://cdn.jsdelivr.net/npm/@99ways/posthog-page-experiments@0.2.0/dist/posthog-page-experiments.min.js'

// The example as published, with a flag key and without the SRI hash, so the local build can stand in for the CDN file.
const example = readFileSync(path.join(repositoryRoot, 'examples/consent-switch.html'), 'utf8')
  .replaceAll('YOUR-FLAG-KEY', flag)
  .replace(/\s+integrity="[^"]*"/, '')

const flagsResponse = JSON.stringify({
  flags: {
    [flag]: { key: flag, enabled: true, variant: 'test', reason: { code: 'condition_match' }, metadata: { id: 1, version: 1 } },
  },
  featureFlags: { [flag]: 'test' },
  featureFlagPayloads: {},
  errorsWhileComputingFlags: false,
})

const statisticsConsent = encodeURIComponent('{necessary:true,preferences:false,statistics:true,marketing:false}')

// A WordPress page whose consent tool blocks the PostHog plugin: both plugin scripts are inert until consent.
function sitePage(pluginVersion: string): string {
  const settings = JSON.stringify({ apiKey: 'phc_test', apiHost: 'https://posthog.test', capturePageview: '1' })
  return `<!doctype html>
<html>
<head>
<script type="text/plain" data-cookieconsent="statistics" id="phi-load-js-js-extra">var phiConfig = ${settings};</script>
<script type="text/plain" data-cookieconsent="statistics" id="phi-load-js-js"
  src="/wp-content/plugins/posthog-integration/assets/frontend/js/load.js?ver=${pluginVersion}"></script>
</head>
<body>
${example}
<h1 data-hero-title>Original headline</h1>
</body>
</html>`
}

interface SentEvent {
  event: string
  properties: Record<string, unknown>
}

// posthog-js sends events gzipped or as plain JSON, as one event, a list, or a { batch } object.
function decodeEvents(body: Buffer): SentEvent[] {
  const text = body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body).toString('utf8') : body.toString('utf8')
  const parsed = JSON.parse(text)
  const events = Array.isArray(parsed) ? parsed : parsed.batch ?? [parsed]
  return events as SentEvent[]
}

async function openSite(page: Page, { consent = false, pluginVersion = 'PLUGIN-FILE-VERSION' } = {}) {
  const sent: SentEvent[] = []
  let flagRequests = 0

  // posthog-js drops events from browsers that look automated.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false })
    Object.defineProperty(navigator, 'userAgentData', { get: () => undefined })
  })
  if (consent) await page.context().addCookies([{ name: 'CookieConsent', value: statisticsConsent, url: 'https://shop.test' }])

  await page.route(runnerUrl, (route) => route.fulfill({ path: experimentBundle, contentType: 'text/javascript' }))
  await page.route('https://posthog.test/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/static/array.js') return route.fulfill({ path: posthogArray, contentType: 'text/javascript' })
    if (url.pathname.startsWith('/flags')) {
      flagRequests += 1
      return route.fulfill({ contentType: 'application/json', body: flagsResponse })
    }
    const body = route.request().postDataBuffer()
    if (body) sent.push(...decodeEvents(body))
    return route.fulfill({ contentType: 'application/json', body: '{}' })
  })
  await page.route('https://shop.test/**', (route) => route.fulfill({ contentType: 'text/html', body: sitePage(pluginVersion) }))
  await page.goto('https://shop.test/')

  return { sent, flagRequests: () => flagRequests }
}

async function storedPostHogKeys(page: Page): Promise<string[]> {
  const cookies = (await page.context().cookies()).map((cookie) => cookie.name)
  const storage = await page.evaluate(() => Object.keys(localStorage))
  return [...cookies, ...storage].filter((key) => key.startsWith('ph_'))
}

const sentNames = (sent: SentEvent[]) => sent.map((event) => event.event).filter((name) => name === '$pageview' || name === '$feature_flag_called')

test.use({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' })

test('assigns at page load but records and stores nothing before consent', async ({ page }) => {
  const site = await openSite(page)

  await expect(page.locator('[data-hero-title]')).toHaveText('A clearer reason to choose the product')
  expect(site.flagRequests()).toBeGreaterThan(0)
  await page.waitForTimeout(1500)
  expect(site.sent).toEqual([])
  expect(await storedPostHogKeys(page)).toEqual([])
})

test('sends the held page view and exposure with the same device ID on consent', async ({ page }) => {
  const site = await openSite(page)
  await expect(page.locator('[data-hero-title]')).toHaveText('A clearer reason to choose the product')
  const deviceId = await page.evaluate(() => (window.posthog as unknown as { get_distinct_id(): string }).get_distinct_id())

  await page.evaluate((value) => {
    document.cookie = `CookieConsent=${value}; path=/`
    window.dispatchEvent(new Event('CookiebotOnAccept'))
  }, statisticsConsent)

  await expect.poll(() => sentNames(site.sent).sort()).toEqual(['$feature_flag_called', '$pageview'])
  const exposure = site.sent.find((event) => event.event === '$feature_flag_called')
  expect(exposure?.properties).toMatchObject({ $feature_flag: flag, $feature_flag_response: 'test', distinct_id: deviceId })
  expect(site.sent.find((event) => event.event === '$pageview')?.properties.distinct_id).toBe(deviceId)
  expect(await storedPostHogKeys(page)).not.toEqual([])
})

test('starts posthog-js normally when consent is already stored', async ({ page }) => {
  const site = await openSite(page, { consent: true })

  await expect(page.locator('[data-hero-title]')).toHaveText('A clearer reason to choose the product')
  await expect.poll(() => sentNames(site.sent).sort()).toEqual(['$feature_flag_called', '$pageview'])
})

test('steps aside when the site\'s PostHog file has changed', async ({ page }) => {
  const summaries: string[] = []
  page.on('console', (message) => { if (message.text().startsWith(`[Experiment:${flag}]`)) summaries.push(message.text()) })
  const site = await openSite(page, { pluginVersion: 'another-version' })

  await expect.poll(() => summaries.length, { timeout: 8000 }).toBe(1)
  expect(summaries[0]).toContain("Variant 'unassigned' (from fallback)")
  expect(await page.evaluate(() => window.posthog)).toBeUndefined()
  await expect(page.locator('[data-hero-title]')).toHaveText('Original headline')
  expect(site.flagRequests()).toBe(0)
})
