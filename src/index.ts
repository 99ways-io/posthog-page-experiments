export type Awaitable<T> = T | PromiseLike<T>

export interface PostHogClient {
  __loaded?: boolean
  getFeatureFlag(featureFlag: string): boolean | string | null | undefined
  onFeatureFlags(callback: () => void): (() => void) | void
}

export type StyleUpdates = Record<string, string | number | null | undefined>

export interface ElementUpdates {
  style?: StyleUpdates
  callback?: (element: HTMLElement, variant: string) => unknown
  innerText?: string
  innerHTML?: string
}

export interface ElementChange {
  selector: string
  updates: ElementUpdates
}

export type VariantStep = ElementChange | (() => unknown)
export type VariantHandler = VariantStep[] | (() => unknown)

export interface ExperimentOptions {
  variants: Record<string, VariantHandler>
  defaultVariant?: string
  isEligible?: () => Awaitable<boolean>
  posthog?: PostHogClient
  debug?: boolean
  featureFlagTimeoutMs?: number
}

export type ExperimentResult = string | null

const DEFAULT_FEATURE_FLAG_TIMEOUT_MS = 4_000
const POSTHOG_POLL_INTERVAL_MS = 50

class Experiment {
  private readonly variants: Map<string, VariantHandler>
  private readonly defaultVariant: string
  private readonly isEligible: () => Awaitable<boolean>
  private readonly explicitPostHog?: PostHogClient
  private readonly debug: boolean
  private readonly featureFlagTimeoutMs: number
  private runPromise: Promise<ExperimentResult> | null = null

  constructor(
    private readonly featureFlag: string,
    options: ExperimentOptions,
  ) {
    if (!featureFlag.trim()) {
      throw new TypeError('featureFlag must be a non-empty string.')
    }

    this.defaultVariant = options.defaultVariant ?? 'control'
    this.variants = new Map(Object.entries(options.variants))
    this.isEligible = options.isEligible ?? (() => true)
    this.explicitPostHog = options.posthog
    this.debug = options.debug ?? false
    this.featureFlagTimeoutMs = options.featureFlagTimeoutMs ?? DEFAULT_FEATURE_FLAG_TIMEOUT_MS

    if (!Number.isFinite(this.featureFlagTimeoutMs) || this.featureFlagTimeoutMs < 0) {
      throw new RangeError('featureFlagTimeoutMs must be a finite number greater than or equal to 0.')
    }

    if (!this.defaultVariant.trim()) {
      throw new TypeError('defaultVariant must be a non-empty string.')
    }

    if (!this.variants.has(this.defaultVariant)) {
      throw new TypeError(`variants must include the default variant '${this.defaultVariant}'.`)
    }
  }

  run(): Promise<ExperimentResult> {
    if (!this.runPromise) this.runPromise = this.runOnce()
    return this.runPromise
  }

  private async runOnce(): Promise<ExperimentResult> {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      this.log('Browser globals are unavailable; skipping the experiment.')
      return null
    }

    await this.waitForDOMContentLoaded()

    this.log('Checking eligibility before evaluating the feature flag.')
    if (!(await this.isEligible())) {
      this.log('Visitor is ineligible; skipping feature-flag evaluation and variant application.')
      return null
    }

    const resolvedVariant = await this.resolveVariant()
    const activeVariant = this.getConfiguredVariantOrDefault(resolvedVariant)
    this.log(`Activated variant '${activeVariant}'.`)
    this.applyVariant(activeVariant)
    return activeVariant
  }

  private getVariantFromQueryParam(): string | null {
    return new URLSearchParams(window.location.search).get(this.featureFlag)
  }

  private getPostHog(): PostHogClient | undefined {
    const posthog = this.explicitPostHog ?? window.posthog

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
          const remove = posthog.onFeatureFlags(() => {
            try {
              const currentPostHog = this.getPostHog()
              if (!currentPostHog) {
                throw new Error('The initialized PostHog instance is no longer available.')
              }

              const flagValue = currentPostHog.getFeatureFlag(this.featureFlag)
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

          if (typeof remove === 'function') unsubscribe = remove
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

  private mapFeatureFlagValue(value: boolean | string | null | undefined): string {
    if (value === true) return 'test'
    if (value === false || value === null || value === undefined || value === '') {
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
    if (document.readyState !== 'loading') {
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

  private applyVariant(variant: string): void {
    const handler = this.variants.get(variant)
    if (!handler) return

    this.log(`Applying variant '${variant}'.`)
    this.applyHandler(handler, variant)
    this.log(`Finished applying variant '${variant}'.`)
  }

  private applyHandler(handler: VariantHandler, variant: string): void {
    if (typeof handler === 'function') {
      handler()
      return
    }

    handler.forEach((step) => {
      if (typeof step === 'function') {
        step()
        return
      }
      this.applyUpdates(step.selector, step.updates, variant)
    })
  }

  private applyUpdates(selector: string, updates: ElementUpdates, variant: string): void {
    const elements = document.querySelectorAll<HTMLElement>(selector)
    if (!elements.length) {
      this.warn(`No elements found for selector '${selector}'.`)
      return
    }

    this.log(`Selector '${selector}' matched ${elements.length} element(s).`)
    elements.forEach((element) => {
      if (updates.style) {
        Object.entries(updates.style).forEach(([property, value]) => {
          if (value === null || value === undefined) return
          const cssProperty = property.startsWith('--')
            ? property
            : property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
          element.style.setProperty(cssProperty, String(value), 'important')
        })
      }

      if (updates.innerText !== undefined) element.innerText = updates.innerText
      if (updates.innerHTML !== undefined) element.innerHTML = updates.innerHTML
      updates.callback?.(element, variant)
    })
  }

  private log(message: string, ...details: unknown[]): void {
    if (this.debug) console.log(`[Experiment:${this.featureFlag}] ${message}`, ...details)
  }

  private warn(message: string, ...details: unknown[]): void {
    if (this.debug) console.warn(`[Experiment:${this.featureFlag}] ${message}`, ...details)
  }
}

export function runExperiment(
  featureFlag: string,
  options: ExperimentOptions,
): Promise<ExperimentResult> {
  return new Experiment(featureFlag, options).run()
}

declare global {
  interface Window {
    posthog?: PostHogClient
    runExperiment: typeof runExperiment
  }
}
