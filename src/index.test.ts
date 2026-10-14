import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { runExperiment } from './index'
import type { PostHogClient } from './index'

class FakeDocument extends EventTarget {
  readyState: DocumentReadyState = 'loading'
  readonly elements = new Map<string, HTMLElement[]>()

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

function installBrowser(document: FakeDocument, search = '', posthog?: PostHogClient): void {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: document,
  })
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { document, location: { search }, posthog },
  })
}

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
  })
})
