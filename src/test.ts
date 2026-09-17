import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import type { PostHog } from 'posthog-js'
import { runExperiment } from '.'

type FeatureFlagsCallback = Parameters<PostHog['onFeatureFlags']>[0]

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
  const styles = new Map<string, string>()
  const element = {
    style: {
      setProperty: (property: string, value: string) => styles.set(property, value),
    },
    innerText: '',
    innerHTML: '',
  } as unknown as HTMLElement

  return { element, styles }
}

// mocked PostHog
function createPostHog(value: boolean | string | undefined) {
  let callback: FeatureFlagsCallback | undefined
  let unsubscribed = false
  let featureFlagReads = 0

  const posthog = {
    __loaded: true,
    getFeatureFlag: () => {
      featureFlagReads += 1
      return value
    },
    onFeatureFlags: (nextCallback: FeatureFlagsCallback) => {
      callback = nextCallback
      return () => { unsubscribed = true }
    },
  } as unknown as PostHog

  return {
    posthog,
    emit: () => callback?.([], {}, { errorsLoading: false }),
    featureFlagReads: () => featureFlagReads,
    wasUnsubscribed: () => unsubscribed,
  }
}

const originalWindow = globalThis.window
const originalDocument = globalThis.document

function installBrowser(document: FakeDocument, search = '', posthog?: PostHog): void {
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

describe('Experiment', () => {
  test('waits for both PostHog and DOMContentLoaded', async () => {
    const document = new FakeDocument()
    const { element, styles } = createElement()
    document.elements.set('.banner', [element])
    const featureFlags = createPostHog('test')
    installBrowser(document, '', featureFlags.posthog)

    const run = runExperiment('banner-test', {
      variants: {
        control: [],
        test: [{ selector: '.banner', updates: { style: { display: 'block' } } }]
      }
    })

    featureFlags.emit()
    await Promise.resolve()
    expect(styles.get('display')).toBeUndefined()

    document.finishLoading()
    expect(await run).toBe('test')
    expect(styles.get('display')).toBe('block')
    expect(featureFlags.wasUnsubscribed()).toBe(true)
  })

  test('maps boolean flags to test and control', async () => {
    for (const [flagValue, expectedVariant] of [[true, 'test'], [false, 'control']] as const) {
      const document = new FakeDocument()
      document.finishLoading()
      const featureFlags = createPostHog(flagValue)
      installBrowser(document, '', featureFlags.posthog)

      const run = runExperiment('boolean-test', { variants: { control: [], test: [] } })

      featureFlags.emit()
      expect(await run).toBe(expectedVariant)
    }
  })

  test('falls back to control for an unconfigured variant', async () => {
    const document = new FakeDocument()
    document.finishLoading()
    const featureFlags = createPostHog('missing-variant')
    installBrowser(document, '', featureFlags.posthog)
    let controlRuns = 0

    const run = runExperiment('unknown-test', {
      variants: {
        control: [() => { controlRuns += 1 }],
        test: []
      }
    })

    featureFlags.emit()
    expect(await run).toBe('control')
    expect(controlRuns).toBe(1)
  })

  test('uses a configured URL override without waiting for PostHog', async () => {
    const document = new FakeDocument()
    document.finishLoading()
    installBrowser(document, '?url-test=test')
    let testRuns = 0

    const variant = await runExperiment('url-test', {
      variants: {
        control: [],
        test: [
          () => { testRuns += 1 }
        ]
      }
    })

    expect(variant).toBe('test')
    expect(testRuns).toBe(1)
  })

  test('runs element callbacks with the selected variant', async () => {
    const document = new FakeDocument()
    document.finishLoading()
    const { element } = createElement()
    document.elements.set('.headline', [element])
    installBrowser(document, '?callback-test=test')
    let callbackVariant: string | undefined

    await runExperiment('callback-test', {
      variants: {
        control: [],
        test: [
          {
            selector: '.headline',
            updates: {
              callback: (callbackElement, variant) => {
                expect(callbackElement).toBe(element)
                callbackVariant = variant
              },
            },
          }
        ]
      }
    })

    expect(callbackVariant).toBe('test')
  })

  test('supports constructor variants and a custom default without PostHog', async () => {
    const document = new FakeDocument()
    document.finishLoading()
    installBrowser(document)
    let baselineRuns = 0

    const variant = await runExperiment('constructor-test', {
      defaultVariant: 'baseline',
      featureFlagTimeoutMs: 1,
      variants: {
        baseline: () => { baselineRuns += 1 },
        test: [],
      },
    })

    expect(variant).toBe('baseline')
    expect(baselineRuns).toBe(1)
  })

  test('keeps SDK diagnostics silent by default', async () => {
    const document = new FakeDocument()
    document.finishLoading()
    installBrowser(document)
    const warn = spyOn(console, 'warn').mockImplementation(() => { })
    const log = spyOn(console, 'log').mockImplementation(() => { })

    try {
      await runExperiment('silent-test', {
        featureFlagTimeoutMs: 1,
        variants: { control: [] },
      })

      expect(warn).not.toHaveBeenCalled()
      expect(log).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
      log.mockRestore()
    }
  })

  test('prints SDK diagnostics when debug is enabled', async () => {
    const document = new FakeDocument()
    document.finishLoading()
    installBrowser(document)
    const warn = spyOn(console, 'warn').mockImplementation(() => { })
    const log = spyOn(console, 'log').mockImplementation(() => { })

    try {
      await runExperiment('debug-test', {
        debug: true,
        featureFlagTimeoutMs: 1,
        variants: { control: [] },
      })

      expect(warn).toHaveBeenCalledWith(
        "[Experiment:debug-test] Feature flag 'debug-test' was not resolved within 1ms. Applying 'control'.",
      )
      expect(log).toHaveBeenCalledWith(
        "[Experiment:debug-test] Activated variant 'control'.",
      )
    } finally {
      warn.mockRestore()
      log.mockRestore()
    }
  })

  test('applies every DOM update type and multiple handlers', async () => {
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
          {
            selector: '.title',
            updates: { innerText: 'Updated title' },
          },
          {
            selector: '.description',
            updates: { innerHTML: 'Save <strong>40%</strong>' },
          },
          {
            selector: '.card',
            updates: {
              style: { backgroundColor: '#111827', padding: 24 },
              callback: (_element, variant) => { callbackVariant = variant },
            },
          },
          () => { functionRuns += 1 }
        ],
      },
    })

    expect(title.element.innerText).toBe('Updated title')
    expect(description.element.innerHTML).toBe('Save <strong>40%</strong>')
    expect(card.styles.get('background-color')).toBe('#111827')
    expect(card.styles.get('padding')).toBe('24')
    expect(callbackVariant).toBe('test')
    expect(functionRuns).toBe(1)
  })

  test('falls back from an invalid URL override to the configured default', async () => {
    const document = new FakeDocument()
    document.finishLoading()
    installBrowser(document, '?invalid-url-test=not-configured')
    let controlRuns = 0

    const variant = await runExperiment('invalid-url-test', {
      variants: {
        control: () => { controlRuns += 1 },
        test: [],
      },
    })

    expect(variant).toBe('control')
    expect(controlRuns).toBe(1)
  })

  test('waits for PostHog to become available before the timeout', async () => {
    const document = new FakeDocument()
    document.finishLoading()
    installBrowser(document)
    const featureFlags = createPostHog('test')

    const run = runExperiment('late-posthog-test', {
      featureFlagTimeoutMs: 250,
      variants: { control: [], test: [] },
    })

    await new Promise((resolve) => setTimeout(resolve, 10))
    window.posthog = featureFlags.posthog
    await new Promise((resolve) => setTimeout(resolve, 60))
    featureFlags.emit()

    expect(await run).toBe('test')
    expect(featureFlags.wasUnsubscribed()).toBe(true)
  })

  test('reads the flag from the current PostHog SDK after the subscribed instance is replaced', async () => {
    const document = new FakeDocument()
    document.finishLoading()
    const subscribedPostHog = createPostHog('control')
    const currentPostHog = createPostHog('test')
    installBrowser(document, '', subscribedPostHog.posthog)
    let controlRuns = 0
    let testRuns = 0

    const run = runExperiment('sdk-replacement-test', {
      variants: {
        control: () => { controlRuns += 1 },
        test: () => { testRuns += 1 },
      },
    })

    window.posthog = currentPostHog.posthog
    subscribedPostHog.emit()

    expect(await run).toBe('test')
    expect(controlRuns).toBe(0)
    expect(testRuns).toBe(1)
    expect(subscribedPostHog.featureFlagReads()).toBe(0)
    expect(currentPostHog.featureFlagReads()).toBe(1)
    expect(subscribedPostHog.wasUnsubscribed()).toBe(true)
  })

  test('starts and caches readiness during construction', async () => {
    const document = new FakeDocument()
    document.finishLoading()
    installBrowser(document)
    const featureFlags = createPostHog('test')
    const experiment = runExperiment('eager-readiness-test', {
      featureFlagTimeoutMs: 250,
      variants: { control: [], test: [] },
    })

    await new Promise((resolve) => setTimeout(resolve, 10))
    window.posthog = featureFlags.posthog
    await new Promise((resolve) => setTimeout(resolve, 60))
    featureFlags.emit()

    expect(await experiment).toBe('test')
  })

  test('falls back and unsubscribes when PostHog never resolves the flag', async () => {
    const document = new FakeDocument()
    document.finishLoading()
    const featureFlags = createPostHog('test')
    installBrowser(document, '', featureFlags.posthog)
    let controlRuns = 0

    const variant = await runExperiment('posthog-timeout-test', {
      featureFlagTimeoutMs: 5,
      variants: {
        control: () => { controlRuns += 1 },
        test: [],
      },
    })

    expect(variant).toBe('control')
    expect(controlRuns).toBe(1)
    expect(featureFlags.wasUnsubscribed()).toBe(true)
  })

  test('rejects invalid feature-flag timeout values', () => {
    expect(() => runExperiment('invalid-timeout-test', {
      featureFlagTimeoutMs: -1,
    })).toThrow(
      'featureFlagTimeoutMs must be a finite number greater than or equal to 0.',
    )
  })
})
