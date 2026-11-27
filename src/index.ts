export type Awaitable<T> = T | PromiseLike<T>

export interface PostHogFeatureFlagDetails {
  reason?: { code?: string | null, description?: string | null } | null
}

export interface PostHogClient {
  __loaded?: boolean
  getFeatureFlag(featureFlag: string): boolean | string | null | undefined
  onFeatureFlags(callback: () => void): (() => void) | void
  /** Optional. Read for the assignment summary when the client provides it. */
  featureFlags?: {
    getFeatureFlagDetails?(featureFlag: string): PostHogFeatureFlagDetails | null | undefined
  }
  /** Optional. Read for the assignment summary when the client provides it. */
  get_property?(property: string): unknown
  /** Optional. Read for the assignment summary when the client provides it. */
  get_distinct_id?(): string
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
/**
 * A variant as listed in `options.variants`: a handler, a text that replaces the text of
 * `options.selector`, or `null` for no change.
 */
export type VariantDefinition = VariantHandler | string | null

/**
 * `summary` logs one assignment line per run, `debug` adds step-by-step diagnostics,
 * and `silent` logs nothing.
 */
export type ExperimentLogLevel = 'silent' | 'summary' | 'debug'

export type AssignmentSource = 'url' | 'posthog' | 'fallback' | 'ineligible'

/** What the assignment summary reports for one run. */
export interface ExperimentAssignment {
  featureFlag: string
  /** The applied variant, or `null` when the visitor is ineligible. */
  variant: string | null
  source: AssignmentSource
  /** The raw value PostHog returned. Present only when the source is `posthog`. */
  flagValue?: boolean | string | null
  /** PostHog's evaluation reason, such as "Matched condition set 1", when the client exposes it. */
  reason?: string
  deviceId?: string | null
  distinctId?: string | null
  /** A plain-language explanation when the default variant was shown for a specific cause. */
  note?: string
}

export interface ExperimentOptions {
  variants: Record<string, VariantDefinition>
  defaultVariant?: string
  isEligible?: () => Awaitable<boolean>
  posthog?: PostHogClient
  log?: ExperimentLogLevel
  /** Shorthand for `log: 'debug'`. Ignored when `log` is set. */
  debug?: boolean
  featureFlagTimeoutMs?: number
  /**
   * The element this experiment changes. Text variants replace its text, `hideUntilReady`
   * hides it, and a visitor whose page has no matching element is not counted.
   */
  selector?: string
  /**
   * Hide `selector` from the moment `runExperiment` is called until a variant is applied
   * or the visitor is shown the default, so nobody sees the element change.
   */
  hideUntilReady?: boolean
  /**
   * The longest `selector` stays hidden, counted from the call. A variant that is not ready
   * by then is not shown and the visitor is not counted. Defaults to `featureFlagTimeoutMs`
   * plus `maxPageAgeMs` (or plus 1000 without `maxPageAgeMs`), so every visitor who can still
   * be counted keeps the element hidden until their variant is applied. Needs `hideUntilReady`.
   */
  hideTimeoutMs?: number
  /**
   * Count the visitor only when the page's HTML started arriving no more than this many
   * milliseconds before the eligibility check. Slower visitors see the default and are not counted.
   * A URL override (`?<flag>=<variant>`) ignores this limit and the hiding time, for QA on slow devices.
   */
  maxPageAgeMs?: number
}

export type ExperimentResult = string | null

const DEFAULT_FEATURE_FLAG_TIMEOUT_MS = 4_000
const POSTHOG_POLL_INTERVAL_MS = 50
const DOM_READY_POLL_INTERVAL_MS = 20
const HIDE_TIMEOUT_MARGIN_MS = 1_000
// The CSS fail-safe shows the element this long after hideTimeoutMs, so the script's own
// timer always runs first and no flag is read once the element can be visible.
const CSS_FAILSAFE_MARGIN_MS = 500
const DEBUG_QUERY_PARAM = 'experiment-debug'

interface Resolution {
  value: string
  source: Exclude<AssignmentSource, 'ineligible'>
  flagValue?: boolean | string | null
  fallback?: 'timeout' | 'error' | 'shown'
  client?: PostHogClient
}

class Experiment {
  private readonly variants: Map<string, VariantDefinition>
  private readonly defaultVariant: string
  private readonly isEligible: () => Awaitable<boolean>
  private readonly explicitPostHog?: PostHogClient
  private logLevel: ExperimentLogLevel
  private readonly featureFlagTimeoutMs: number
  private readonly selector?: string
  private readonly hideUntilReady: boolean
  private readonly hideTimeoutMs: number
  private readonly maxPageAgeMs?: number
  private runPromise: Promise<ExperimentResult> | null = null
  private hideStyle: HTMLStyleElement | null = null
  private hideTimer: ReturnType<typeof setTimeout> | undefined
  private pageAgeTimer: ReturnType<typeof setTimeout> | undefined
  private shownBeforeReady = false
  private pageTooSlow = false
  private onShownBeforeReady: (() => void) | undefined

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
    this.logLevel = options.log ?? (options.debug ? 'debug' : 'summary')
    this.featureFlagTimeoutMs = options.featureFlagTimeoutMs ?? DEFAULT_FEATURE_FLAG_TIMEOUT_MS
    this.selector = options.selector
    this.hideUntilReady = options.hideUntilReady ?? false
    this.maxPageAgeMs = options.maxPageAgeMs
    this.hideTimeoutMs = options.hideTimeoutMs
      ?? this.featureFlagTimeoutMs + (this.maxPageAgeMs ?? HIDE_TIMEOUT_MARGIN_MS)

    if (!['silent', 'summary', 'debug'].includes(this.logLevel)) {
      throw new TypeError("log must be 'silent', 'summary', or 'debug'.")
    }

    if (!Number.isFinite(this.featureFlagTimeoutMs) || this.featureFlagTimeoutMs < 0) {
      throw new RangeError('featureFlagTimeoutMs must be a finite number greater than or equal to 0.')
    }

    if (!this.defaultVariant.trim()) {
      throw new TypeError('defaultVariant must be a non-empty string.')
    }

    if (!this.variants.has(this.defaultVariant)) {
      throw new TypeError(`variants must include the default variant '${this.defaultVariant}'.`)
    }

    if (this.selector !== undefined && (typeof this.selector !== 'string' || !this.selector.trim())) {
      throw new TypeError('selector must be a non-empty string.')
    }

    if (this.selector !== undefined && typeof document !== 'undefined') {
      try {
        document.querySelectorAll(this.selector)
      } catch {
        throw new TypeError(`selector '${this.selector}' is not a valid CSS selector.`)
      }
    }

    this.variants.forEach((variant, name) => {
      if (typeof variant === 'string' && !variant.trim()) {
        throw new TypeError(`Variant '${name}' is an empty text. Use null to leave the page unchanged.`)
      }
      if (variant !== null && typeof variant !== 'string' && typeof variant !== 'function' && !Array.isArray(variant)) {
        throw new TypeError(`Variant '${name}' must be a function, an array of steps, a text, or null.`)
      }
    })

    const hasTextVariant = [...this.variants.values()].some((variant) => typeof variant === 'string')
    if (hasTextVariant && !this.selector) {
      throw new TypeError('selector is required when a variant is a text.')
    }

    if (this.hideUntilReady && !this.selector) {
      throw new TypeError('selector is required when hideUntilReady is true.')
    }

    if (options.hideTimeoutMs !== undefined && !this.hideUntilReady) {
      throw new TypeError('hideTimeoutMs needs hideUntilReady: true.')
    }

    if (this.maxPageAgeMs !== undefined && (!Number.isFinite(this.maxPageAgeMs) || this.maxPageAgeMs < 0)) {
      throw new RangeError('maxPageAgeMs must be a finite number greater than or equal to 0.')
    }

    if (!Number.isFinite(this.hideTimeoutMs) || this.hideTimeoutMs < 0) {
      throw new RangeError('hideTimeoutMs must be a finite number greater than or equal to 0.')
    }
  }

  run(): Promise<ExperimentResult> {
    if (!this.runPromise) {
      if (typeof window !== 'undefined' && typeof document !== 'undefined') {
        // A page that is already older than maxPageAgeMs is not counted, so it is not hidden either.
        if (this.isPageTooOld()) this.pageTooSlow = true
        else this.hide()
      }
      const run = this.runOnce()
      this.runPromise = run.finally(() => this.reveal())
    }
    return this.runPromise
  }

  private async runOnce(): Promise<ExperimentResult> {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      this.log('Browser globals are unavailable; skipping the experiment.')
      return null
    }

    if (this.isDebugRequestedByUrl()) this.logLevel = 'debug'

    await this.waitForDOMReady()

    const notCountedReason = await this.checkEligibility()
    if (!notCountedReason && this.pageAgeTimer !== undefined) {
      // The visitor is counted; from here only hideTimeoutMs limits how long the element stays hidden.
      clearTimeout(this.pageAgeTimer)
      this.pageAgeTimer = undefined
    }
    if (notCountedReason) {
      this.log('Visitor is ineligible; skipping feature-flag evaluation and variant application.')
      this.summarize({
        featureFlag: this.featureFlag,
        variant: null,
        source: 'ineligible',
        note: notCountedReason,
      })
      return null
    }

    const resolution = await this.resolveVariant()
    const activeVariant = this.getConfiguredVariantOrDefault(resolution.value)
    this.log(`Activated variant '${activeVariant}'.`)
    this.summarize(this.describeAssignment(resolution, activeVariant))
    this.applyVariant(activeVariant)
    return activeVariant
  }

  /** Returns why the visitor is not counted, or `null` when the visitor is eligible. */
  private async checkEligibility(): Promise<string | null> {
    this.log('Checking eligibility before evaluating the feature flag.')

    // A URL override is for QA: the time limits do not apply to it.
    const timed = !this.getVariantFromQueryParam()

    if (timed && this.shownBeforeReady) {
      return `The element was shown after ${this.hideTimeoutMs}ms before a variant could be chosen, so the feature flag was not evaluated.`
    }

    if (timed && this.maxPageAgeMs !== undefined) {
      const pageAge = this.getPageAgeMs()
      if (this.pageTooSlow || pageAge > this.maxPageAgeMs) {
        return `The page took ${Math.round(pageAge)}ms, more than maxPageAgeMs (${this.maxPageAgeMs}ms), so the feature flag was not evaluated.`
      }
    }

    if (this.selector && document.querySelectorAll(this.selector).length === 0) {
      return `No element matches '${this.selector}', so the feature flag was not evaluated.`
    }

    if (!(await this.isEligible())) {
      return 'The visitor is not eligible, so the feature flag was not evaluated.'
    }

    return null
  }

  // Time since the page's HTML started arriving. Network and server time before that is not counted.
  // A prerendered page counts from the moment the visitor opens it.
  private getPageAgeMs(): number {
    const performance = window.performance
    if (!performance || typeof performance.now !== 'function') return 0
    if ((document as Document & { prerendering?: boolean }).prerendering === true) return 0
    const navigation = typeof performance.getEntriesByType === 'function'
      ? performance.getEntriesByType('navigation')[0] as (PerformanceNavigationTiming & { activationStart?: number }) | undefined
      : undefined
    const htmlArrived = Math.max(navigation?.responseStart || 0, navigation?.activationStart || 0)
    return performance.now() - htmlArrived
  }

  private isPageTooOld(): boolean {
    return this.maxPageAgeMs !== undefined && !this.getVariantFromQueryParam() && this.getPageAgeMs() > this.maxPageAgeMs
  }

  private hide(): void {
    if (!this.hideUntilReady || !this.selector) return

    try {
      if (document.querySelectorAll(this.selector).length > 0) {
        this.warn(`'${this.selector}' already exists when hiding starts; call runExperiment() above it in the HTML so it is never painted first.`)
      }
      const name = `ppe-reveal-${Math.random().toString(36).slice(2)}`
      const style = document.createElement('style')
      // The animation shows the element shortly after hideTimeoutMs even if this script stops running.
      const failsafeMs = Math.ceil(this.hideTimeoutMs) + CSS_FAILSAFE_MARGIN_MS
      style.textContent = `${this.selector}{visibility:hidden;animation:${name} 0s linear ${failsafeMs}ms forwards}`
        + `@keyframes ${name}{to{visibility:visible}}`
      ;(document.head ?? document.documentElement).appendChild(style)
      this.hideStyle = style
      this.hideTimer = setTimeout(() => {
        this.shownBeforeReady = true
        this.warn(`No variant was ready within ${this.hideTimeoutMs}ms; showing '${this.selector}' unchanged.`)
        this.reveal()
        this.onShownBeforeReady?.()
      }, this.hideTimeoutMs)
      // A page that passes maxPageAgeMs while still loading will not be counted: show it now
      // instead of keeping the element hidden until hideTimeoutMs.
      if (this.maxPageAgeMs !== undefined && !this.getVariantFromQueryParam()) {
        this.pageAgeTimer = setTimeout(() => {
          this.pageTooSlow = true
          this.reveal()
        }, Math.max(0, this.maxPageAgeMs - this.getPageAgeMs()))
      }
      this.log(`Hiding '${this.selector}' until a variant is ready.`)
    } catch (error) {
      this.warn(`Could not hide '${this.selector}'.`, error)
    }
  }

  private reveal(): void {
    if (this.hideTimer !== undefined) {
      clearTimeout(this.hideTimer)
      this.hideTimer = undefined
    }
    if (this.pageAgeTimer !== undefined) {
      clearTimeout(this.pageAgeTimer)
      this.pageAgeTimer = undefined
    }
    if (!this.hideStyle) return
    this.hideStyle.remove()
    this.hideStyle = null
    this.log(`Showing '${this.selector}'.`)
  }

  private getVariantFromQueryParam(): string | null {
    return new URLSearchParams(window.location.search).get(this.featureFlag)
  }

  // `?experiment-debug` enables debug logs for every experiment on the page;
  // `?experiment-debug=flag-a,flag-b` limits them to the listed flags.
  private isDebugRequestedByUrl(): boolean {
    const value = new URLSearchParams(window.location.search).get(DEBUG_QUERY_PARAM)
    if (value === null) return false
    const keys = value.split(',').map((key) => key.trim()).filter(Boolean)
    return keys.length === 0 || keys.includes('1') || keys.includes('true') || keys.includes(this.featureFlag)
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

  private resolveVariant(): Promise<Resolution> {
    const queryVariant = this.getVariantFromQueryParam()
    if (queryVariant) {
      this.log(`Using query-string override variant '${queryVariant}'.`)
      return Promise.resolve({ value: queryVariant, source: 'url' })
    }

    this.log('Waiting for initialized PostHog and its first feature-flag notification.')
    return new Promise<Resolution>((resolve) => {
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
        this.onShownBeforeReady = undefined
        if (!removePostHogSubscription()) unsubscribeWhenAvailable = true
      }

      const finish = (resolution: Resolution) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(resolution)
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
            // A notification after the run has finished must not read the flag: reading sends an exposure.
            if (settled) return
            if (this.shownBeforeReady) {
              finish({ value: this.defaultVariant, source: 'fallback', fallback: 'shown' })
              return
            }
            try {
              const currentPostHog = this.getPostHog()
              if (!currentPostHog) {
                throw new Error('The initialized PostHog instance is no longer available.')
              }

              const flagValue = currentPostHog.getFeatureFlag(this.featureFlag)
              const variant = this.mapFeatureFlagValue(flagValue)
              this.log(`PostHog resolved variant '${variant}' from raw value ${JSON.stringify(flagValue)}.`)
              finish({ value: variant, source: 'posthog', flagValue: flagValue ?? null, client: currentPostHog })
            } catch (error) {
              this.warn(
                `Could not read feature flag '${this.featureFlag}'. Applying '${this.defaultVariant}'.`,
                error,
              )
              finish({ value: this.defaultVariant, source: 'fallback', fallback: 'error' })
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
          finish({ value: this.defaultVariant, source: 'fallback', fallback: 'error' })
          return true
        }
      }

      if (this.shownBeforeReady) {
        finish({ value: this.defaultVariant, source: 'fallback', fallback: 'shown' })
        return
      }
      // Once the element has been shown unchanged, stop waiting: the flag will not be read.
      this.onShownBeforeReady = () => finish({ value: this.defaultVariant, source: 'fallback', fallback: 'shown' })

      timeoutTimer = setTimeout(() => {
        this.warn(
          `Feature flag '${this.featureFlag}' was not resolved within ${this.featureFlagTimeoutMs}ms. Applying '${this.defaultVariant}'.`,
        )
        finish({ value: this.defaultVariant, source: 'fallback', fallback: 'timeout' })
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

  private describeAssignment(resolution: Resolution, activeVariant: string): ExperimentAssignment {
    const assignment: ExperimentAssignment = {
      featureFlag: this.featureFlag,
      variant: activeVariant,
      source: resolution.source,
    }
    const shown = `'${activeVariant}' is shown`

    if (resolution.source === 'url') {
      assignment.note = activeVariant === resolution.value
        ? 'Variant forced by the URL parameter; PostHog was not called.'
        : `URL variant '${resolution.value}' is not configured, so ${shown}.`
      return assignment
    }

    if (resolution.source === 'fallback') {
      assignment.note = resolution.fallback === 'timeout'
        ? `PostHog did not return feature flags within ${this.featureFlagTimeoutMs}ms, so ${shown}.`
        : resolution.fallback === 'shown'
          ? `The element was shown after ${this.hideTimeoutMs}ms before PostHog answered, so ${shown} and the flag was not read.`
          : `The feature flag could not be read, so ${shown}.`
      return assignment
    }

    const client = resolution.client
    assignment.flagValue = resolution.flagValue ?? null
    const reason = this.readSafely(() => {
      const details = client?.featureFlags?.getFeatureFlagDetails?.(this.featureFlag)
      return details?.reason?.description || details?.reason?.code || undefined
    })
    if (reason) assignment.reason = reason
    if (typeof client?.get_property === 'function') {
      assignment.deviceId = this.readSafely(() => this.asText(client.get_property?.('$device_id')))
    }
    if (typeof client?.get_distinct_id === 'function') {
      assignment.distinctId = this.readSafely(() => this.asText(client.get_distinct_id?.()))
    }

    const flagValue = assignment.flagValue
    if (flagValue === false || flagValue === null || flagValue === '') {
      assignment.note = assignment.deviceId === null
        ? `PostHog returned no variant, and this browser has no PostHog device ID. Flags that bucket by device cannot assign it, so ${shown}.`
        : `PostHog returned no variant for this visitor, so ${shown}.`
    } else if (activeVariant !== resolution.value) {
      assignment.note = `Flag value '${resolution.value}' is not a configured variant, so ${shown}.`
    }
    return assignment
  }

  private readSafely<T>(read: () => T): T | undefined {
    try {
      return read()
    } catch {
      return undefined
    }
  }

  private asText(value: unknown): string | null {
    return typeof value === 'string' && value ? value : null
  }

  private summarize(assignment: ExperimentAssignment): void {
    if (this.logLevel === 'silent') return
    const origin = assignment.source === 'ineligible' ? 'not applied' : `from ${assignment.source}`
    console.info(
      `[Experiment:${this.featureFlag}] Variant ${assignment.variant === null ? 'none' : `'${assignment.variant}'`} (${origin}).`,
      assignment,
    )
  }

  // Consent tools such as Cookiebot can hold DOMContentLoaded listeners back, so the ready
  // state is also checked on a short interval; whichever comes first ends the wait.
  private waitForDOMReady(): Promise<void> {
    if (document.readyState !== 'loading') {
      this.log('DOM is already ready; skipping the DOMContentLoaded wait.')
      return Promise.resolve()
    }

    this.log('Waiting for DOMContentLoaded.')
    return new Promise((resolve) => {
      let poll: ReturnType<typeof setInterval> | undefined
      const done = () => {
        if (poll === undefined) return
        clearInterval(poll)
        poll = undefined
        document.removeEventListener('DOMContentLoaded', done)
        this.log('DOM is ready.')
        resolve()
      }
      poll = setInterval(() => {
        if (document.readyState !== 'loading') done()
      }, DOM_READY_POLL_INTERVAL_MS)
      document.addEventListener('DOMContentLoaded', done, { once: true })
    })
  }

  private applyVariant(variant: string): void {
    if (!this.variants.has(variant)) return
    const handler = this.variants.get(variant) as VariantDefinition

    this.log(`Applying variant '${variant}'.`)
    this.applyHandler(handler, variant)
    this.log(`Finished applying variant '${variant}'.`)
  }

  private applyHandler(handler: VariantDefinition, variant: string): void {
    if (handler === null) return

    if (typeof handler === 'string') {
      if (this.selector) this.applyUpdates(this.selector, { innerText: handler }, variant)
      return
    }

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
    if (this.logLevel === 'debug') console.log(`[Experiment:${this.featureFlag}] ${message}`, ...details)
  }

  private warn(message: string, ...details: unknown[]): void {
    if (this.logLevel === 'debug') console.warn(`[Experiment:${this.featureFlag}] ${message}`, ...details)
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
