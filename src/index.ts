import type { PostHog } from 'posthog-js'


declare global {
  interface Window {
    posthog?: PostHog
    createExperiment: (...args: ConstructorParameters<typeof Experiment>) => Experiment
  }
}

type CSSRules = Partial<Record<keyof CSSStyleDeclaration, string | number>>
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



export class Experiment {
  private readonly variants = new Map<string, Set<VariantHandler>>()
  private activeVariant: string | null = null
  private readyPromise: Promise<string>;
  private ran: boolean = false;
  private defaultVariant: string = 'control';
  constructor(
    private readonly featureFlag: string,
    initialConfig?: {
      defaultVariant?: string
      variants?: Record<string, VariantHandler>,
    }
  ) {
    if (initialConfig?.defaultVariant)
      this.defaultVariant = initialConfig.defaultVariant;
    if (initialConfig?.variants) {
      Object.entries(initialConfig?.variants).forEach(([variant, handler]) => {
        this.on(variant, handler);
      })
    }
    this.readyPromise = Promise.all([
      this.resolveVariant(),
      this.waitForDOMContentLoaded(),
    ]).then(([variant]) => {
      this.activeVariant = this.getConfiguredVariantOrDefault(variant)
      return this.activeVariant
    })
  }

  on(variant: string, handler: VariantHandler): this {
    if (this.ran) {
      throw new Error(`Cannot register variant '${variant}' after the experiment has started.`)
    }

    let handlers = this.variants.get(variant)
    if (!handlers) {
      handlers = new Set<VariantHandler>()
      this.variants.set(variant, handlers)
    }
    handlers.add(handler)

    return this
  }

  run(): Promise<string | null> {
    return this.readyPromise.then(async () => {
      this.ran = true;
      await this.applyActiveVariant()
      return this.activeVariant;
    })
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
      && typeof posthog.onFeatureFlags === 'function'
      && typeof posthog.getFeatureFlag === 'function'
    ) {
      return posthog
    }

    return undefined
  }

  private resolveVariant(): Promise<string> {
    const queryVariant = this.getVariantFromQueryParam()
    if (queryVariant) return Promise.resolve(queryVariant)

    const posthog = this.getPostHog()
    if (!posthog) {
      console.warn(
        `PostHog is unavailable. Applying '${this.defaultVariant}' by default.`,
      )
      return Promise.resolve(this.defaultVariant)
    }

    return new Promise<string>((resolve) => {
      let settled = false
      let unsubscribe: (() => void) | undefined
      let unsubscribeWhenAvailable = false

      const finish = (variant: string) => {
        if (settled) return
        settled = true
        resolve(variant)

        if (unsubscribe) unsubscribe()
        else unsubscribeWhenAvailable = true
      }

      try {
        unsubscribe = posthog.onFeatureFlags(() => {
          const flagValue = posthog.getFeatureFlag(this.featureFlag)
          finish(this.mapFeatureFlagValue(flagValue))
        })

        // PostHog may invoke the callback synchronously before returning the cleanup function.
        if (unsubscribeWhenAvailable) unsubscribe()
      } catch (error) {
        console.warn(
          `Could not resolve feature flag '${this.featureFlag}'. Applying '${this.defaultVariant}'.`,
          error,
        )
        finish(this.defaultVariant)
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

    console.warn(
      `Variant '${variant}' is not configured for '${this.featureFlag}'. Applying '${this.defaultVariant}'.`,
    )
    return this.defaultVariant
  }

  private waitForDOMContentLoaded(): Promise<void> {
    if (typeof document === 'undefined' || document.readyState !== 'loading') {
      return Promise.resolve()
    }

    return new Promise((resolve) => {
      document.addEventListener('DOMContentLoaded', () => resolve(), { once: true })
    })
  }

  private applyActiveVariant(): void {
    if (!this.activeVariant) return

    const handlers = this.variants.get(this.activeVariant)
    if (!handlers) {
      console.warn(
        `Default variant '${this.activeVariant}' is not configured for '${this.featureFlag}'.`,
      )
      return
    }

    handlers.forEach((handler) => this.applyHandler(handler))
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
      console.warn('No elements found for selector:', selector)
      return
    }

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
}
export function createExperiment(...args: ConstructorParameters<typeof Experiment>): Experiment {
  return new Experiment(...args);
}

if (typeof window !== 'undefined') window.createExperiment = createExperiment
