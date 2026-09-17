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

  test('is silent by default and emits diagnostics only when enabled', async () => {
    const document = new FakeDocument()
    document.finishLoading()
    installBrowser(document, '?diagnostic-test=control')
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const log = spyOn(console, 'log').mockImplementation(() => {})

    try {
      await runExperiment('diagnostic-test', { variants: { control: [] } })
      expect(warn).not.toHaveBeenCalled()
      expect(log).not.toHaveBeenCalled()

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
    expect(() => runExperiment('invalid-timeout', {
      featureFlagTimeoutMs: -1,
      variants: { control: [] },
    })).toThrow('featureFlagTimeoutMs must be a finite number greater than or equal to 0.')
  })
})
