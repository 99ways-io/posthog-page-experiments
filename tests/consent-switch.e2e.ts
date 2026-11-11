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

// The site's own loader: PostHog's standard snippet and init, as the plugin's load.js runs them once consent releases it.
const siteLoader = example.split('\n').find((line) => line.trim().startsWith('!function(t,e)'))!
  .trim()
  .replace('p.setAttribute("data-cookieconsent","ignore"),', '')
  + ` posthog.init(phiConfig.apiKey, { api_host: phiConfig.apiHost, capture_pageview: true, person_profiles: 'always' });`

const flagsResponse = JSON.stringify({
  flags: {
    [flag]: { key: flag, enabled: true, variant: 'test', reason: { code: 'condition_match' }, metadata: { id: 1, version: 1 } },
  },
  featureFlags: { [flag]: 'test' },
  featureFlagPayloads: {},
  errorsWhileComputingFlags: false,
})

const statisticsConsent = encodeURIComponent('{necessary:true,preferences:false,statistics:true,marketing:false}')
const noStatisticsConsent = encodeURIComponent('{necessary:true,preferences:false,statistics:false,marketing:false}')
const changedHeadline = 'A clearer reason to choose the product'

interface SiteOptions {
  consent?: string
  pluginVersion?: string
  loggedIn?: boolean
  // The consent tool releases the site's own PostHog scripts on page load, as it does once consent is stored.
  siteLoaderRuns?: boolean
  // posthog-js storage left by an earlier visit with consent.
  earlierVisit?: boolean
}

// A WordPress page whose consent tool blocks the PostHog plugin: both plugin scripts are inert until consent.
function sitePage(options: SiteOptions): string {
  const settings = JSON.stringify({ apiKey: 'phc_test', apiHost: 'https://posthog.test', capturePageview: '1' })
  return `<!doctype html>
<html>
<head>
<script type="text/plain" data-cookieconsent="statistics" id="phi-load-js-js-extra">var phiConfig = ${settings};</script>
<script type="text/plain" data-cookieconsent="statistics" id="phi-load-js-js"
  src="/wp-content/plugins/posthog-integration/assets/frontend/js/load.js?ver=${options.pluginVersion ?? 'PLUGIN-FILE-VERSION'}"></script>
</head>
<body class="${options.loggedIn ? 'logged-in' : ''}">
${example}
<h1 data-hero-title>Original headline</h1>
${options.siteLoaderRuns ? `<script>var phiConfig = ${settings};</script><script>${siteLoader}</script>` : ''}
</body>
</html>`
}

interface SentEvent {
  event: string
  properties: Record<string, unknown>
}

// posthog-js sends events gzipped or as plain JSON, as one event, a list, or a { batch } object.
function decodeEvents(body: Buffer): SentEvent[] {
  try {
    const text = body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body).toString('utf8') : body.toString('utf8')
    const parsed = JSON.parse(text)
    return (Array.isArray(parsed) ? parsed : parsed.batch ?? [parsed]) as SentEvent[]
  } catch {
    return [{ event: 'undecoded', properties: {} }]
  }
}

// The flag request body is base64-encoded JSON in a `data` form field.
function flagRequestDistinctId(body: string): unknown {
  try {
    return JSON.parse(Buffer.from(decodeURIComponent(body.replace(/^data=/, '')), 'base64').toString('utf8')).distinct_id
  } catch {
    return undefined
  }
}

async function openSite(page: Page, options: SiteOptions = {}) {
  const sent: SentEvent[] = []
  const flagRequestIds: unknown[] = []
  let posthogLoads = 0

  // posthog-js drops events from browsers that look automated.
  await page.addInitScript((earlierVisit) => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false })
    Object.defineProperty(navigator, 'userAgentData', { get: () => undefined })
    if (earlierVisit && !sessionStorage.getItem('seeded')) {
      sessionStorage.setItem('seeded', '1')
      localStorage.setItem('__ph_opt_in_out_phc_test', '1')
      localStorage.setItem('ph_phc_test_posthog', JSON.stringify({ distinct_id: 'earlier-visit-id', $device_id: 'earlier-visit-id' }))
    }
  }, options.earlierVisit ?? false)
  if (options.consent) await page.context().addCookies([{ name: 'CookieConsent', value: options.consent, url: 'https://shop.test' }])
  if (options.earlierVisit) {
    const identity = encodeURIComponent(JSON.stringify({ distinct_id: 'earlier-visit-id', $device_id: 'earlier-visit-id' }))
    await page.context().addCookies([{ name: 'ph_phc_test_posthog', value: identity, url: 'https://shop.test' }])
  }

  await page.route(runnerUrl, (route) => route.fulfill({ path: experimentBundle, contentType: 'text/javascript' }))
  await page.route('https://posthog.test/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/static/array.js') {
      posthogLoads += 1
      return route.fulfill({ path: posthogArray, contentType: 'text/javascript' })
    }
    if (url.pathname.startsWith('/flags')) {
      flagRequestIds.push(flagRequestDistinctId(route.request().postData() ?? ''))
      return route.fulfill({ contentType: 'application/json', body: flagsResponse })
    }
    const body = route.request().postDataBuffer()
    if (body) sent.push(...decodeEvents(body))
    return route.fulfill({ contentType: 'application/json', body: '{}' })
  })
  await page.route('https://shop.test/**', (route) => route.fulfill({ contentType: 'text/html', body: sitePage(options) }))
  await page.goto('https://shop.test/')

  return { sent, flagRequestIds, posthogLoads: () => posthogLoads }
}

async function storedPostHogKeys(page: Page): Promise<string[]> {
  const cookies = (await page.context().cookies()).map((cookie) => cookie.name)
  const storage = await page.evaluate(() => [...Object.keys(localStorage), ...Object.keys(sessionStorage)])
  return [...cookies, ...storage].filter((key) => key.includes('ph_'))
}

const isCapturing = (page: Page) => page.evaluate(() => (window.posthog as unknown as { is_capturing(): boolean }).is_capturing())
const distinctId = (page: Page) => page.evaluate(() => (window.posthog as unknown as { get_distinct_id(): string }).get_distinct_id())
const count = (sent: SentEvent[], name: string) => sent.filter((event) => event.event === name).length

async function setConsent(page: Page, value: string, event: string) {
  await page.evaluate(([cookie, name]) => {
    document.cookie = `CookieConsent=${cookie}; path=/`
    window.dispatchEvent(new Event(name!))
  }, [value, event])
}

// Longer than posthog-js's send interval, so anything captured by mistake would have been sent.
const sendInterval = 4000

test.use({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' })

test('assigns at page load but records and stores nothing before consent', async ({ page }) => {
  const site = await openSite(page)

  await expect(page.locator('[data-hero-title]')).toHaveText(changedHeadline)
  expect(site.flagRequestIds).toHaveLength(1)
  expect(await isCapturing(page)).toBe(false)
  await page.waitForTimeout(sendInterval)
  expect(site.sent).toEqual([])
  expect(await storedPostHogKeys(page)).toEqual([])
})

test('sends the held page view and exposure with the same device ID on consent', async ({ page }) => {
  const site = await openSite(page)
  await expect(page.locator('[data-hero-title]')).toHaveText(changedHeadline)
  const deviceId = await distinctId(page)

  await setConsent(page, statisticsConsent, 'CookiebotOnAccept')

  await expect.poll(() => count(site.sent, '$feature_flag_called') + count(site.sent, '$pageview')).toBe(2)
  const exposure = site.sent.find((event) => event.event === '$feature_flag_called')
  expect(exposure?.properties).toMatchObject({ $feature_flag: flag, $feature_flag_response: 'test', distinct_id: deviceId })
  expect(site.sent.find((event) => event.event === '$pageview')?.properties.distinct_id).toBe(deviceId)
  expect(site.flagRequestIds).toEqual([deviceId])
  expect(await storedPostHogKeys(page)).not.toEqual([])
})

test('keeps the device ID and variant on a reload after consent', async ({ page }) => {
  const site = await openSite(page)
  await expect(page.locator('[data-hero-title]')).toHaveText(changedHeadline)
  const deviceId = await distinctId(page)
  await setConsent(page, statisticsConsent, 'CookiebotOnAccept')
  await expect.poll(() => count(site.sent, '$pageview')).toBe(1)

  await page.reload()

  await expect(page.locator('[data-hero-title]')).toHaveText(changedHeadline)
  expect(await distinctId(page)).toBe(deviceId)
  await expect.poll(() => count(site.sent, '$pageview')).toBe(2)
})

test('starts posthog-js normally when consent is already stored', async ({ page }) => {
  const site = await openSite(page, { consent: statisticsConsent })

  await expect(page.locator('[data-hero-title]')).toHaveText(changedHeadline)
  expect(await isCapturing(page)).toBe(true)
  await expect.poll(() => count(site.sent, '$feature_flag_called') + count(site.sent, '$pageview')).toBe(2)
})

test('loads posthog-js once and counts the visitor once when the site\'s own loader also runs', async ({ page }) => {
  const site = await openSite(page, { consent: statisticsConsent, siteLoaderRuns: true })

  await expect(page.locator('[data-hero-title]')).toHaveText(changedHeadline)
  await page.waitForTimeout(sendInterval)
  expect(site.posthogLoads()).toBe(1)
  expect(count(site.sent, '$pageview')).toBe(1)
  expect(count(site.sent, '$feature_flag_called')).toBe(1)
})

test('stops recording and clears storage when consent is withdrawn on the page', async ({ page }) => {
  const site = await openSite(page)
  await expect(page.locator('[data-hero-title]')).toHaveText(changedHeadline)
  await setConsent(page, statisticsConsent, 'CookiebotOnAccept')
  await expect.poll(() => count(site.sent, '$pageview')).toBe(1)

  await setConsent(page, noStatisticsConsent, 'CookiebotOnDecline')
  await expect.poll(() => isCapturing(page)).toBe(false)
  await page.evaluate(() => (window.posthog as unknown as { capture(event: string): void }).capture('after_withdrawal'))
  await page.waitForTimeout(sendInterval)

  expect(count(site.sent, 'after_withdrawal')).toBe(0)
  expect((await storedPostHogKeys(page)).filter((key) => !key.startsWith('__ph_opt_in_out_'))).toEqual([])
})

test('ignores an opt-in stored before consent was withdrawn', async ({ page }) => {
  const site = await openSite(page, { consent: noStatisticsConsent, earlierVisit: true })

  await expect(page.locator('[data-hero-title]')).toHaveText(changedHeadline)
  expect(await isCapturing(page)).toBe(false)
  expect(site.flagRequestIds).toHaveLength(1)
  expect(site.flagRequestIds[0]).not.toBe('earlier-visit-id')
  await page.waitForTimeout(sendInterval)
  expect(site.sent).toEqual([])
  expect(await storedPostHogKeys(page)).toEqual([])
})

test('leaves logged-in visitors to the site\'s own PostHog setup', async ({ page }) => {
  const site = await openSite(page, { loggedIn: true })

  await page.waitForTimeout(1000)
  expect(await page.evaluate(() => window.posthog)).toBeUndefined()
  expect(site.flagRequestIds).toEqual([])
})

test('steps aside when the site\'s PostHog file has changed', async ({ page }) => {
  const summaries: string[] = []
  page.on('console', (message) => { if (message.text().startsWith(`[Experiment:${flag}]`)) summaries.push(message.text()) })
  const site = await openSite(page, { pluginVersion: 'PLUGIN-FILE-VERSION.1' })

  await expect.poll(() => summaries.length, { timeout: 8000 }).toBe(1)
  expect(summaries[0]).toContain("Variant 'unassigned' (from fallback)")
  expect(await page.evaluate(() => window.posthog)).toBeUndefined()
  await expect(page.locator('[data-hero-title]')).toHaveText('Original headline')
  expect(site.flagRequestIds).toEqual([])
})
