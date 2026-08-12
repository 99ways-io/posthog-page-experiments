import type { PostHog } from 'posthog-js'

declare global {
  interface Window {
    posthog?: PostHog
    createExperiment: (...args: ConstructorParameters<typeof Experiment>) => Experiment
  }
}

type CSSRules = Partial<Record<keyof CSSStyleDeclaration, string | number>>
const DEFAULT_FEATURE_FLAG_TIMEOUT_MS = 4_000
const POSTHOG_POLL_INTERVAL_MS = 50

export type VariationUpdate = {
  selector: string
  updates: {
    style?: CSSRules
    callback?: (element: HTMLElement, variant: string) => unknown
    innerText?: string
    innerHTML?: string
  }
}
export type Config = VariationUpdate[]
export type VariantHandler = Config | (() => unknown)
export type ExperimentOptions = {
  defaultVariant?: string
  variants?: Record<string, VariantHandler>
  debug?: boolean
  featureFlagTimeoutMs?: number
}



export class Experiment {
  private readonly variants = new Map<string, Set<VariantHandler>>()
  private activeVariant: string | null = null
  private readonly readyPromise: Promise<string>
  private runPromise: Promise<string> | null = null
  private defaultVariant: string = 'control';
  private readonly debug: boolean
  private readonly featureFlagTimeoutMs: number

  constructor(
    private readonly featureFlag: string,
    initialConfig: ExperimentOptions = {},
  ) {
    this.debug = initialConfig.debug ?? false
    this.featureFlagTimeoutMs = initialConfig.featureFlagTimeoutMs ?? DEFAULT_FEATURE_FLAG_TIMEOUT_MS
    if (!Number.isFinite(this.featureFlagTimeoutMs) || this.featureFlagTimeoutMs < 0) {
      throw new RangeError('featureFlagTimeoutMs must be a finite number greater than or equal to 0.')
    }

    if (initialConfig.defaultVariant)
      this.defaultVariant = initialConfig.defaultVariant;
    if (initialConfig.variants) {
      Object.entries(initialConfig.variants).forEach(([variant, handler]) => {
        this.on(variant, handler);
      })
    }

    this.log(`Starting readiness with a ${this.featureFlagTimeoutMs}ms feature-flag timeout.`)
    this.readyPromise = Promise.all([
      this.resolveVariant(),
      this.waitForDOMContentLoaded(),
    ]).then(([variant]) => {
      this.log(`Readiness completed with candidate variant '${variant}'.`)
      return variant
    })
  }

  on(variant: string, handler: VariantHandler): this {
    if (this.runPromise) {
      throw new Error(`Cannot register variant '${variant}' after the experiment has started.`)
    }

    let handlers = this.variants.get(variant)
    if (!handlers) {
      handlers = new Set<VariantHandler>()
      this.variants.set(variant, handlers)
    }
    handlers.add(handler)
    this.log(`Registered a handler for variant '${variant}'.`)

    return this
  }

  run(): Promise<string> {
    if (!this.runPromise) {
      this.log('Run requested; waiting for cached readiness.')
      this.runPromise = this.readyPromise.then((variant) => {
        this.activeVariant = this.getConfiguredVariantOrDefault(variant)
        this.log(`Activated variant '${this.activeVariant}'.`)
        this.applyActiveVariant()
        return this.activeVariant
      })
    }

    return this.runPromise
  }

  private getVariantFromQueryParam(): string | null {
    if (typeof window === 'undefined') return null
    return new URLSearchParams(window.location.search).get(this.featureFlag)
  }

  private getPostHog(): PostHog | undefined {
    if (typeof window === 'undefined') return undefined

    const posthog = window.posthog
    if (
      posthog
      && posthog.__loaded === true
      && typeof posthog.onFeatureFlags === 'function'
      && typeof posthog.getFeatureFlag === 'function'
    ) {
      return posthog
    }

    return undefined
  }

  private resolveVariant(): Promise<string> {
    const queryVariant = this.getVariantFromQueryParam()
    if (queryVariant) {
      this.log(`Using query-string override variant '${queryVariant}'.`)
      return Promise.resolve(queryVariant)
    }

    if (typeof window === 'undefined') {
      this.warn(
        `Window is unavailable. Applying '${this.defaultVariant}' by default.`,
      )
      return Promise.resolve(this.defaultVariant)
    }

    this.log('Waiting for initialized PostHog and its first feature-flag notification.')
    return new Promise<string>((resolve) => {
      let settled = false
      let unsubscribe: (() => void) | undefined
      let unsubscribeWhenAvailable = false
      let pollTimer: ReturnType<typeof setInterval> | undefined
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined

      const removePostHogSubscription = (): boolean => {
        if (!unsubscribe) return false

        const remove = unsubscribe
        unsubscribe = undefined
        try {
          remove()
        } catch (error) {
          this.warn(`Could not unsubscribe from feature flag '${this.featureFlag}'.`, error)
        }
        return true
      }

      const cleanup = () => {
        if (pollTimer !== undefined) clearInterval(pollTimer)
        if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)

        if (!removePostHogSubscription()) unsubscribeWhenAvailable = true
      }

      const finish = (variant: string) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(variant)
      }

      const subscribeToPostHog = (): boolean => {
        if (settled) return true

        const posthog = this.getPostHog()
        if (!posthog) return false

        if (pollTimer !== undefined) {
          clearInterval(pollTimer)
          pollTimer = undefined
        }

        try {
          this.log('PostHog is initialized; subscribing to feature flags.')
          unsubscribe = posthog.onFeatureFlags(() => {
            try {
              const flagValue = posthog.getFeatureFlag(this.featureFlag)
              const variant = this.mapFeatureFlagValue(flagValue)
              this.log(`PostHog resolved variant '${variant}' from raw value ${JSON.stringify(flagValue)}.`)
              finish(variant)
            } catch (error) {
              this.warn(
                `Could not read feature flag '${this.featureFlag}'. Applying '${this.defaultVariant}'.`,
                error,
              )
              finish(this.defaultVariant)
            }
          })

          // PostHog may invoke the callback synchronously before returning cleanup.
          if (unsubscribeWhenAvailable) {
            unsubscribeWhenAvailable = false
            removePostHogSubscription()
          }
          return true
        } catch (error) {
          this.warn(
            `Could not subscribe to feature flag '${this.featureFlag}'. Applying '${this.defaultVariant}'.`,
            error,
          )
          finish(this.defaultVariant)
          return true
        }
      }

      timeoutTimer = setTimeout(() => {
        this.warn(
          `Feature flag '${this.featureFlag}' was not resolved within ${this.featureFlagTimeoutMs}ms. Applying '${this.defaultVariant}'.`,
        )
        finish(this.defaultVariant)
      }, this.featureFlagTimeoutMs)

      if (!subscribeToPostHog()) {
        pollTimer = setInterval(subscribeToPostHog, POSTHOG_POLL_INTERVAL_MS)
      }
    })
  }

  private mapFeatureFlagValue(value: boolean | string | undefined): string {
    if (value === true) return 'test'
    if (value === false || value === undefined || value === '') {
      return this.defaultVariant
    }
    return value
  }

  private getConfiguredVariantOrDefault(variant: string): string {
    if (this.variants.has(variant)) return variant

    this.warn(
      `Variant '${variant}' is not configured for '${this.featureFlag}'. Applying '${this.defaultVariant}'.`,
    )
    return this.defaultVariant
  }

  private waitForDOMContentLoaded(): Promise<void> {
    if (typeof document === 'undefined' || document.readyState !== 'loading') {
      this.log('DOM is already ready; skipping the DOMContentLoaded wait.')
      return Promise.resolve()
    }

    this.log('Waiting for DOMContentLoaded.')
    return new Promise((resolve) => {
      document.addEventListener('DOMContentLoaded', () => {
        this.log('DOMContentLoaded received.')
        resolve()
      }, { once: true })
    })
  }

  private applyActiveVariant(): void {
    if (!this.activeVariant) return

    const handlers = this.variants.get(this.activeVariant)
    if (!handlers) {
      this.warn(
        `Default variant '${this.activeVariant}' is not configured for '${this.featureFlag}'.`,
      )
      return
    }

    this.log(`Applying ${handlers.size} handler(s) for variant '${this.activeVariant}'.`)
    handlers.forEach((handler) => this.applyHandler(handler))
    this.log(`Finished applying variant '${this.activeVariant}'.`)
  }

  private applyHandler(handler: VariantHandler): void {
    if (typeof handler === 'function') {
      handler()
      return
    }

    handler.forEach(({ selector, updates }) => {
      this.applyUpdates(selector, updates)
    })
  }

  private applyUpdates(selector: string, updates: VariationUpdate['updates']): void {
    const elements = document.querySelectorAll<HTMLElement>(selector)
    if (!elements.length) {
      this.warn('No elements found for selector:', selector)
      return
    }

    this.log(`Selector '${selector}' matched ${elements.length} element(s).`)
    elements.forEach((element) => {
      if (updates.style) {
        Object.entries(updates.style).forEach(([property, value]) => {
          const cssProperty = property.startsWith('--')
            ? property
            : property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
          element.style.setProperty(cssProperty, String(value), 'important')
        })
      }

      if (updates.innerText !== undefined) element.innerText = updates.innerText
      if (updates.innerHTML !== undefined) element.innerHTML = updates.innerHTML
      if (updates.callback) updates.callback(element, this.activeVariant!)
    })
  }

  private log(message: string, ...details: unknown[]): void {
    if (this.debug) console.log(`[Experiment:${this.featureFlag}] ${message}`, ...details)
  }

  private warn(message: string, ...details: unknown[]): void {
    if (this.debug) console.warn(`[Experiment:${this.featureFlag}] ${message}`, ...details)
  }
}
export function createExperiment(...args: ConstructorParameters<typeof Experiment>): Experiment {
  return new Experiment(...args);
}

if (typeof window !== 'undefined') window.createExperiment = createExperiment
