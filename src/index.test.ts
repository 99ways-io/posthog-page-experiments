import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { runExperiment } from './index'
import type { PostHogClient } from './index'

class FakeStyle {
  textContent = ''
  removed = false
  constructor(private readonly owner: FakeDocument) {}
  remove(): void {
    this.removed = true
    this.owner.styles = this.owner.styles.filter((style) => style !== this)
  }
}

class FakeDocument extends EventTarget {
  readyState: DocumentReadyState = 'loading'
  readonly elements = new Map<string, HTMLElement[]>()
  styles: FakeStyle[] = []
  readonly head = { appendChild: (style: FakeStyle) => { this.styles.push(style) } }

  createElement(): FakeStyle {
    return new FakeStyle(this)
  }

  querySelectorAll<T extends Element>(selector: string): NodeListOf<T> {
    const elements = this.elements.get(selector) ?? []
    return {
      length: elements.length,
      forEach: (callback: (element: T, index: number, list: NodeListOf<T>) => void) => {
        elements.forEach((element, index) => callback(
          element as unknown as T,
          index,
          this.querySelectorAll<T>(selector),
        ))
      },
    } as NodeListOf<T>
  }

  finishLoading(): void {
    this.readyState = 'interactive'
    this.dispatchEvent(new Event('DOMContentLoaded'))
  }
}

function createElement() {
  const styles = new Map<string, { value: string, priority: string }>()
  const element = {
    style: {
      setProperty: (property: string, value: string, priority: string) => {
        styles.set(property, { value, priority })
      },
    },
    dataset: {},
    innerText: '',
    innerHTML: '',
  } as unknown as HTMLElement

  return { element, styles }
}

function createPostHog(value: boolean | string | null | undefined) {
  let callback: (() => void) | undefined
  let unsubscribed = false
  let featureFlagReads = 0
  let subscriptions = 0

  const posthog: PostHogClient = {
    __loaded: true,
    getFeatureFlag: () => {
      featureFlagReads += 1
      return value
    },
    onFeatureFlags: (nextCallback) => {
      subscriptions += 1
      callback = nextCallback
      return () => { unsubscribed = true }
    },
  }

  return {
    posthog,
    emit: () => callback?.(),
    featureFlagReads: () => featureFlagReads,
    subscriptions: () => subscriptions,
    wasUnsubscribed: () => unsubscribed,
  }
}

async function waitForSubscription(featureFlags: ReturnType<typeof createPostHog>): Promise<void> {
  for (let attempt = 0; attempt < 20 && featureFlags.subscriptions() === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  expect(featureFlags.subscriptions()).toBe(1)
}

const originalWindow = globalThis.window
const originalDocument = globalThis.document

function installBrowser(
  document: FakeDocument,
  search = '',
  posthog?: PostHogClient,
  performance?: { now: () => number, getEntriesByType: (type: string) => unknown[] },
): void {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: document,
  })
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { document, location: { search }, posthog, performance },
  })
}

function pagePerformance(now: number, responseStart: number) {
  return {
    now: () => now,
    getEntriesByType: (type: string) => (type === 'navigation' ? [{ responseStart }] : []),
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

afterEach(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalWindow,
  })
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: originalDocument,
  })
})

describe('runExperiment', () => {
  test('checks DOM readiness and eligibility before evaluating PostHog', async () => {
    const document = new FakeDocument()
    const { element, styles } = createElement()
    document.elements.set('.banner', [element])
    const featureFlags = createPostHog('test')
    installBrowser(document, '', featureFlags.posthog)
    let eligibilityChecks = 0

    const result = runExperiment('banner-test', {
      isEligible: () => {
        eligibilityChecks += 1
        return document.querySelectorAll('.banner').length > 0
      },
      variants: {
        control: [],
        test: [{ selector: '.banner', updates: { style: { display: 'block' } } }],
      },
    })

    expect(featureFlags.subscriptions()).toBe(0)
    expect(featureFlags.featureFlagReads()).toBe(0)

    document.finishLoading()
    await waitForSubscription(featureFlags)
    expect(eligibilityChecks).toBe(1)

    featureFlags.emit()
    expect(await result).toBe('test')
    expect(styles.get('display')).toEqual({ value: 'block', priority: 'important' })
    expect(featureFlags.featureFlagReads()).toBe(1)
    expect(featureFlags.wasUnsubscribed()).toBe(true)
  })

  test('skips PostHog and returns null when the visitor is ineligible', async () => {
    const document = new FakeDocument()
    document.finishLoading()
    const featureFlags = createPostHog('test')
    installBrowser(document, '', featureFlags.posthog)
    let testRuns = 0

    const result = await runExperiment('eligibility-test', {
      isEligible: async () => false,
      variants: {
        control: [],
        test: () => { testRuns += 1 },
      },
    })

    expect(result).toBeNull()
    expect(testRuns).toBe(0)
    expect(featureFlags.subscriptions()).toBe(0)
    expect(featureFlags.featureFlagReads()).toBe(0)
  })

  test('propagates eligibility errors without evaluating PostHog', async () => {
    const document = new FakeDocument()
    document.finishLoading()
    const featureFlags = createPostHog('test')
    installBrowser(document, '', featureFlags.posthog)

    const result = runExperiment('eligibility-error-test', {
      isEligible: () => { throw new Error('eligibility failed') },
      variants: { control: [], test: [] },
    })

    await expect(result).rejects.toThrow('eligibility failed')
    expect(featureFlags.subscriptions()).toBe(0)
    expect(featureFlags.featureFlagReads()).toBe(0)
  })

  test('uses a URL override without waiting for PostHog', async () => {
    const document = new FakeDocument()
    document.finishLoading()
    installBrowser(document, '?url-test=test')
    let testRuns = 0

    const variant = await runExperiment('url-test', {
      variants: {
        control: [],
        test: () => { testRuns += 1 },
      },
    })

    expect(variant).toBe('test')
    expect(testRuns).toBe(1)
  })

  test('uses an explicitly supplied PostHog client', async () => {
    const document = new FakeDocument()
    document.finishLoading()
    installBrowser(document)
    const featureFlags = createPostHog('test')

    const result = runExperiment('explicit-client-test', {
      posthog: featureFlags.posthog,
      variants: { control: [], test: [] },
    })

    await waitForSubscription(featureFlags)
    featureFlags.emit()
    expect(await result).toBe('test')
  })

  test('maps boolean flags to test and control', async () => {
    for (const [flagValue, expectedVariant] of [[true, 'test'], [false, 'control']] as const) {
      const document = new FakeDocument()
      document.finishLoading()
      const featureFlags = createPostHog(flagValue)
      installBrowser(document, '', featureFlags.posthog)

      const result = runExperiment('boolean-test', {
        variants: { control: [], test: [] },
      })

      await waitForSubscription(featureFlags)
      featureFlags.emit()
      expect(await result).toBe(expectedVariant)
    }
  })

  test('falls back to the configured default for an unknown variant', async () => {
    const document = new FakeDocument()
    document.finishLoading()
    const featureFlags = createPostHog('missing-variant')
    installBrowser(document, '', featureFlags.posthog)
    let baselineRuns = 0

    const result = runExperiment('unknown-test', {
      defaultVariant: 'baseline',
      variants: {
        baseline: () => { baselineRuns += 1 },
        test: [],
      },
    })

    await waitForSubscription(featureFlags)
    featureFlags.emit()
    expect(await result).toBe('baseline')
    expect(baselineRuns).toBe(1)
  })

  test('applies every DOM update type and mixed custom functions', async () => {
    const document = new FakeDocument()
    document.finishLoading()
    const title = createElement()
    const description = createElement()
    const card = createElement()
    document.elements.set('.title', [title.element])
    document.elements.set('.description', [description.element])
    document.elements.set('.card', [card.element])
    installBrowser(document, '?all-updates=test')
    let callbackVariant: string | undefined
    let functionRuns = 0

    await runExperiment('all-updates', {
      variants: {
        control: [],
        test: [
          { selector: '.title', updates: { innerText: 'Updated title' } },
          { selector: '.description', updates: { innerHTML: 'Save <strong>40%</strong>' } },
          {
            selector: '.card',
            updates: {
              style: { backgroundColor: '#111827', padding: 24, opacity: null },
              callback: (_element, variant) => { callbackVariant = variant },
            },
          },
          () => { functionRuns += 1 },
        ],
      },
    })

    expect(title.element.innerText).toBe('Updated title')
    expect(description.element.innerHTML).toBe('Save <strong>40%</strong>')
    expect(card.styles.get('background-color')).toEqual({ value: '#111827', priority: 'important' })
    expect(card.styles.get('padding')).toEqual({ value: '24', priority: 'important' })
    expect(card.styles.has('opacity')).toBe(false)
    expect(callbackVariant).toBe('test')
    expect(functionRuns).toBe(1)
  })

  test('waits for a late PostHog client and reads from its current instance', async () => {
    const document = new FakeDocument()
    document.finishLoading()
    installBrowser(document)
    const subscribedPostHog = createPostHog('control')
    const currentPostHog = createPostHog('test')

    const result = runExperiment('sdk-replacement-test', {
      featureFlagTimeoutMs: 250,
      variants: { control: [], test: [] },
    })

    await new Promise((resolve) => setTimeout(resolve, 10))
    window.posthog = subscribedPostHog.posthog
    await new Promise((resolve) => setTimeout(resolve, 60))
    window.posthog = currentPostHog.posthog
    subscribedPostHog.emit()

    expect(await result).toBe('test')
    expect(subscribedPostHog.featureFlagReads()).toBe(0)
    expect(currentPostHog.featureFlagReads()).toBe(1)
    expect(subscribedPostHog.wasUnsubscribed()).toBe(true)
  })

  test('falls back and unsubscribes when PostHog never resolves the flag', async () => {
    const document = new FakeDocument()
    document.finishLoading()
    const featureFlags = createPostHog('test')
    installBrowser(document, '', featureFlags.posthog)

    const variant = await runExperiment('posthog-timeout-test', {
      featureFlagTimeoutMs: 5,
      variants: { control: [], test: [] },
    })

    expect(variant).toBe('control')
    expect(featureFlags.wasUnsubscribed()).toBe(true)
  })

  test('logs one assignment summary by default and step diagnostics only when enabled', async () => {
    const document = new FakeDocument()
    document.finishLoading()
    installBrowser(document, '?diagnostic-test=control')
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const log = spyOn(console, 'log').mockImplementation(() => {})
    const info = spyOn(console, 'info').mockImplementation(() => {})

    try {
      await runExperiment('diagnostic-test', { variants: { control: [] } })
      expect(warn).not.toHaveBeenCalled()
      expect(log).not.toHaveBeenCalled()
      expect(info).toHaveBeenCalledTimes(1)
      expect(info).toHaveBeenCalledWith("[Experiment:diagnostic-test] Variant 'control' (from url).", {
        featureFlag: 'diagnostic-test',
        variant: 'control',
        source: 'url',
        note: 'Variant forced by the URL parameter; PostHog was not called.',
      })

      await runExperiment('diagnostic-test', {
        debug: true,
        variants: { control: [] },
      })
      expect(log).toHaveBeenCalledWith(
        "[Experiment:diagnostic-test] Activated variant 'control'.",
      )
    } finally {
      warn.mockRestore()
      log.mockRestore()
      info.mockRestore()
    }
  })

  test('logs nothing when log is silent', async () => {
    const document = new FakeDocument()
    document.finishLoading()
    installBrowser(document, '?silent-test=test')
    const spies = (['info', 'log', 'warn'] as const).map((method) => spyOn(console, method).mockImplementation(() => {}))

    try {
      expect(await runExperiment('silent-test', {
        log: 'silent',
        variants: { control: [], test: [] },
      })).toBe('test')
      spies.forEach((spy) => expect(spy).not.toHaveBeenCalled())
    } finally {
      spies.forEach((spy) => spy.mockRestore())
    }
  })

  test('the experiment-debug URL parameter enables step diagnostics for listed flags', async () => {
    const document = new FakeDocument()
    document.finishLoading()
    installBrowser(document, '?experiment-debug=url-debug-test&url-debug-test=test&other-test=test')
    const log = spyOn(console, 'log').mockImplementation(() => {})
    const info = spyOn(console, 'info').mockImplementation(() => {})

    try {
      await runExperiment('url-debug-test', { variants: { control: [], test: [] } })
      expect(log).toHaveBeenCalledWith("[Experiment:url-debug-test] Activated variant 'test'.")
      log.mockClear()

      await runExperiment('other-test', { variants: { control: [], test: [] } })
      expect(log).not.toHaveBeenCalled()
    } finally {
      log.mockRestore()
      info.mockRestore()
    }
  })

  test('summarizes a PostHog assignment with its reason and identifiers', async () => {
    const document = new FakeDocument()
    document.finishLoading()
    const featureFlags = createPostHog('test')
    Object.assign(featureFlags.posthog, {
      featureFlags: {
        getFeatureFlagDetails: () => ({ reason: { code: 'condition_match', description: 'Matched condition set 1' } }),
      },
      get_property: (property: string) => (property === '$device_id' ? 'device-1' : undefined),
      get_distinct_id: () => 'person-1',
    })
    installBrowser(document, '', featureFlags.posthog)
    const info = spyOn(console, 'info').mockImplementation(() => {})

    try {
      const result = runExperiment('summary-test', { variants: { control: [], test: [] } })
      await waitForSubscription(featureFlags)
      featureFlags.emit()

      expect(await result).toBe('test')
      expect(featureFlags.featureFlagReads()).toBe(1)
      expect(info).toHaveBeenCalledWith("[Experiment:summary-test] Variant 'test' (from posthog).", {
        featureFlag: 'summary-test',
        variant: 'test',
        source: 'posthog',
        flagValue: 'test',
        reason: 'Matched condition set 1',
        deviceId: 'device-1',
        distinctId: 'person-1',
      })
    } finally {
      info.mockRestore()
    }
  })

  test('explains a default variant caused by a missing PostHog device ID', async () => {
    const document = new FakeDocument()
    document.finishLoading()
    const featureFlags = createPostHog(false)
    Object.assign(featureFlags.posthog, {
      featureFlags: {
        getFeatureFlagDetails: () => ({ reason: { code: 'out_of_rollout_bound', description: 'Out of rollout bound' } }),
      },
      get_property: () => undefined,
      get_distinct_id: () => 'returning-visitor',
    })
    installBrowser(document, '', featureFlags.posthog)
    const info = spyOn(console, 'info').mockImplementation(() => {})

    try {
      const result = runExperiment('device-test', { variants: { control: [], test: [] } })
      await waitForSubscription(featureFlags)
      featureFlags.emit()

      expect(await result).toBe('control')
      const [, assignment] = info.mock.calls[0] as [string, Record<string, unknown>]
      expect(assignment).toMatchObject({
        variant: 'control',
        source: 'posthog',
        flagValue: false,
        reason: 'Out of rollout bound',
        deviceId: null,
      })
      expect(String(assignment.note)).toContain('no PostHog device ID')
    } finally {
      info.mockRestore()
    }
  })

  test('summarizes timeouts, unknown variants, and ineligible visitors', async () => {
    const document = new FakeDocument()
    document.finishLoading()
    const info = spyOn(console, 'info').mockImplementation(() => {})

    try {
      installBrowser(document, '', createPostHog('test').posthog)
      expect(await runExperiment('timeout-summary', {
        featureFlagTimeoutMs: 5,
        variants: { control: [], test: [] },
      })).toBe('control')
      expect(info.mock.calls[0]?.[1]).toMatchObject({
        source: 'fallback',
        note: "PostHog did not return feature flags within 5ms, so 'control' is shown.",
      })

      installBrowser(document, '?unknown-summary=test_group_9')
      expect(await runExperiment('unknown-summary', { variants: { control: [], test: [] } })).toBe('control')
      expect(info.mock.calls[1]?.[1]).toMatchObject({
        source: 'url',
        note: "URL variant 'test_group_9' is not configured, so 'control' is shown.",
      })

      expect(await runExperiment('ineligible-summary', {
        isEligible: () => false,
        variants: { control: [], test: [] },
      })).toBeNull()
      expect(info.mock.calls[2]).toEqual([
        '[Experiment:ineligible-summary] Variant none (not applied).',
        {
          featureFlag: 'ineligible-summary',
          variant: null,
          source: 'ineligible',
          note: 'The visitor is not eligible, so the feature flag was not evaluated.',
        },
      ])
    } finally {
      info.mockRestore()
    }
  })

  test('applies text variants to the selector and leaves null variants unchanged', async () => {
    const document = new FakeDocument()
    const { element } = createElement()
    element.innerText = 'Original headline'
    document.elements.set('.hero h1', [element])
    const featureFlags = createPostHog('test_group_1')
    installBrowser(document, '', featureFlags.posthog)

    const result = runExperiment('text-test', {
      selector: '.hero h1',
      log: 'silent',
      variants: { control: null, test_group_1: 'New headline' },
    })
    document.finishLoading()
    await waitForSubscription(featureFlags)
    featureFlags.emit()

    expect(await result).toBe('test_group_1')
    expect(element.innerText).toBe('New headline')

    const controlDocument = new FakeDocument()
    const control = createElement()
    control.element.innerText = 'Original headline'
    controlDocument.elements.set('.hero h1', [control.element])
    const controlFlags = createPostHog('control')
    installBrowser(controlDocument, '', controlFlags.posthog)
    controlDocument.finishLoading()
    const controlResult = runExperiment('text-test', {
      selector: '.hero h1',
      log: 'silent',
      variants: { control: null, test_group_1: 'New headline' },
    })
    await waitForSubscription(controlFlags)
    controlFlags.emit()
    expect(await controlResult).toBe('control')
    expect(control.element.innerText).toBe('Original headline')
  })

  test('does not count a visitor whose page has no element for the selector', async () => {
    const document = new FakeDocument()
    const featureFlags = createPostHog('test_group_1')
    installBrowser(document, '', featureFlags.posthog)
    const info = spyOn(console, 'info').mockImplementation(() => {})

    try {
      const result = runExperiment('missing-element-test', {
        selector: '.hero h1',
        variants: { control: null, test_group_1: 'New headline' },
      })
      document.finishLoading()

      expect(await result).toBeNull()
      expect(featureFlags.subscriptions()).toBe(0)
      expect(featureFlags.featureFlagReads()).toBe(0)
      expect(info.mock.calls[0]?.[1]).toMatchObject({
        source: 'ineligible',
        note: "No element matches '.hero h1', so the feature flag was not evaluated.",
      })
    } finally {
      info.mockRestore()
    }
  })

  test('does not count a visitor whose page took longer than maxPageAgeMs', async () => {
    const slowDocument = new FakeDocument()
    slowDocument.elements.set('.hero h1', [createElement().element])
    const slowFlags = createPostHog('test_group_1')
    installBrowser(slowDocument, '', slowFlags.posthog, pagePerformance(4_200, 500))
    const info = spyOn(console, 'info').mockImplementation(() => {})

    try {
      const slow = runExperiment('page-age-test', {
        selector: '.hero h1',
        maxPageAgeMs: 3_500,
        variants: { control: null, test_group_1: 'New headline' },
      })
      slowDocument.finishLoading()
      expect(await slow).toBeNull()
      expect(slowFlags.featureFlagReads()).toBe(0)
      expect(info.mock.calls[0]?.[1]).toMatchObject({
        source: 'ineligible',
        note: 'The page took 3700ms, more than maxPageAgeMs (3500ms), so the feature flag was not evaluated.',
      })
    } finally {
      info.mockRestore()
    }

    const fastDocument = new FakeDocument()
    fastDocument.elements.set('.hero h1', [createElement().element])
    const fastFlags = createPostHog('test_group_1')
    installBrowser(fastDocument, '', fastFlags.posthog, pagePerformance(3_900, 500))
    const fast = runExperiment('page-age-test', {
      selector: '.hero h1',
      maxPageAgeMs: 3_500,
      log: 'silent',
      variants: { control: null, test_group_1: 'New headline' },
    })
    fastDocument.finishLoading()
    await waitForSubscription(fastFlags)
    fastFlags.emit()
    expect(await fast).toBe('test_group_1')
  })

  test('hides the selector from the call until the variant is applied', async () => {
    const document = new FakeDocument()
    const { element } = createElement()
    document.elements.set('.hero h1', [element])
    const featureFlags = createPostHog('test_group_1')
    installBrowser(document, '', featureFlags.posthog)

    const result = runExperiment('hide-test', {
      selector: '.hero h1',
      hideUntilReady: true,
      log: 'silent',
      variants: { control: null, test_group_1: 'New headline' },
    })

    expect(document.styles).toHaveLength(1)
    expect(document.styles[0]?.textContent).toContain('.hero h1{visibility:hidden;')

    document.finishLoading()
    await waitForSubscription(featureFlags)
    expect(document.styles).toHaveLength(1)
    featureFlags.emit()

    expect(await result).toBe('test_group_1')
    expect(element.innerText).toBe('New headline')
    expect(document.styles).toHaveLength(0)
  })

  test('shows the hidden selector again when the visitor is not counted', async () => {
    const document = new FakeDocument()
    const featureFlags = createPostHog('test_group_1')
    installBrowser(document, '', featureFlags.posthog)

    const result = runExperiment('hide-ineligible-test', {
      selector: '.hero h1',
      hideUntilReady: true,
      log: 'silent',
      variants: { control: null, test_group_1: 'New headline' },
    })
    expect(document.styles).toHaveLength(1)
    document.finishLoading()

    expect(await result).toBeNull()
    expect(document.styles).toHaveLength(0)
  })

  test('shows the selector unchanged and reads no flag when PostHog answers after hideTimeoutMs', async () => {
    const document = new FakeDocument()
    const { element } = createElement()
    element.innerText = 'Original headline'
    document.elements.set('.hero h1', [element])
    const featureFlags = createPostHog('test_group_1')
    installBrowser(document, '', featureFlags.posthog)
    const info = spyOn(console, 'info').mockImplementation(() => {})

    try {
      const result = runExperiment('hide-timeout-test', {
        selector: '.hero h1',
        hideUntilReady: true,
        hideTimeoutMs: 20,
        featureFlagTimeoutMs: 1_000,
        variants: { control: null, test_group_1: 'New headline' },
      })
      document.finishLoading()
      await waitForSubscription(featureFlags)
      await wait(40)
      expect(document.styles).toHaveLength(0)

      featureFlags.emit()
      expect(await result).toBe('control')
      expect(element.innerText).toBe('Original headline')
      expect(featureFlags.featureFlagReads()).toBe(0)
      expect(info.mock.calls[0]?.[1]).toMatchObject({ source: 'fallback', variant: 'control' })
      expect(String((info.mock.calls[0]?.[1] as { note?: string }).note)).toContain('shown after 20ms')
    } finally {
      info.mockRestore()
    }
  })

  test('shows the hidden selector as soon as a still-loading page passes maxPageAgeMs', async () => {
    const document = new FakeDocument()
    document.elements.set('.hero h1', [createElement().element])
    const featureFlags = createPostHog('test_group_1')
    let now = 1_000
    installBrowser(document, '', featureFlags.posthog, {
      now: () => now,
      getEntriesByType: () => [{ responseStart: 0 }],
    })

    const result = runExperiment('hide-page-age-test', {
      selector: '.hero h1',
      hideUntilReady: true,
      maxPageAgeMs: 1_030,
      log: 'silent',
      variants: { control: null, test_group_1: 'New headline' },
    })
    expect(document.styles).toHaveLength(1)
    await wait(60)
    expect(document.styles).toHaveLength(0)

    now = 2_000
    document.finishLoading()
    expect(await result).toBeNull()
    expect(featureFlags.featureFlagReads()).toBe(0)
  })

  test('starts when the page is ready even if DOMContentLoaded never reaches listeners', async () => {
    const document = new FakeDocument()
    const featureFlags = createPostHog('test')
    installBrowser(document, '', featureFlags.posthog)

    const result = runExperiment('ready-state-test', {
      log: 'silent',
      variants: { control: [], test: [] },
    })
    document.readyState = 'interactive'

    await wait(60)
    expect(featureFlags.subscriptions()).toBe(1)
    featureFlags.emit()
    expect(await result).toBe('test')
  })

  test('returns null when called outside a browser', async () => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: undefined })
    Object.defineProperty(globalThis, 'document', { configurable: true, value: undefined })

    expect(await runExperiment('ssr-test', {
      variants: { control: [] },
    })).toBeNull()
  })

  test('rejects invalid configuration before starting', () => {
    expect(() => runExperiment('', { variants: { control: [] } }))
      .toThrow('featureFlag must be a non-empty string.')
    expect(() => runExperiment('missing-default', { variants: { test: [] } }))
      .toThrow("variants must include the default variant 'control'.")
    expect(() => runExperiment('invalid-log', {
      log: 'verbose' as never,
      variants: { control: [] },
    })).toThrow("log must be 'silent', 'summary', or 'debug'.")
    expect(() => runExperiment('invalid-timeout', {
      featureFlagTimeoutMs: -1,
      variants: { control: [] },
    })).toThrow('featureFlagTimeoutMs must be a finite number greater than or equal to 0.')
    expect(() => runExperiment('text-without-selector', {
      variants: { control: null, test: 'New headline' },
    })).toThrow('selector is required when a variant is a text.')
    expect(() => runExperiment('hide-without-selector', {
      hideUntilReady: true,
      variants: { control: [] },
    })).toThrow('selector is required when hideUntilReady is true.')
    expect(() => runExperiment('empty-selector', {
      selector: ' ',
      variants: { control: [] },
    })).toThrow('selector must be a non-empty string.')
    expect(() => runExperiment('invalid-page-age', {
      maxPageAgeMs: Number.NaN,
      variants: { control: [] },
    })).toThrow('maxPageAgeMs must be a finite number greater than or equal to 0.')
    expect(() => runExperiment('invalid-hide-timeout', {
      selector: '.hero h1',
      hideUntilReady: true,
      hideTimeoutMs: -5,
      variants: { control: [] },
    })).toThrow('hideTimeoutMs must be a finite number greater than or equal to 0.')
  })
})
