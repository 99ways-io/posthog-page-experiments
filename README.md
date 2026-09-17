# A/B Experiment Kit

A small browser kit for running PostHog-backed A/B and multivariate experiments. Pass every variant to `runExperiment()`, and the kit resolves the visitor's group, waits for the DOM, applies that variant, and returns the activated variant name.

## What it can do today

Listed from the kit's primary purpose down to supporting conveniences:

1. **Run PostHog-backed A/B and multivariate experiments.** It resolves string variants such as `control`, `test_group_1`, or `test_group_2` through `window.posthog`. Boolean flags follow the convention `true` → `test` and `false` → the configured default variant.
2. **Apply declarative DOM variations.** A variant can target any CSS selector, update every matching element, set inline styles with `!important`, replace `innerText`, or replace `innerHTML` with trusted markup.
3. **Fail safely to a known experience.** Late or non-responsive PostHog initialization, empty or disabled flags, and unconfigured variant names fall back to `control` or a custom `defaultVariant` after a configurable deadline.
4. **Force variants through the URL for QA.** A query parameter named after the feature flag takes precedence over PostHog, allowing a configured variant to be previewed before its PostHog flag or rollout exists.
5. **Mix DOM updates and custom functions.** A variant can contain selector-based updates, standalone functions, or both in the order they should run. A variant may also be represented by one standalone function.
6. **Run per-element callbacks.** An update callback runs for every matching element and receives both the element and the active variant name.
7. **Coordinate PostHog, flag, and DOM readiness.** The kit waits for a late-loading initialized PostHog instance and its first feature-flag notification while also awaiting `DOMContentLoaded`. If the overall feature-flag deadline expires first, it uses the default variant.
8. **Run multiple independent experiments on the same page.** Each `runExperiment()` invocation has its own feature flag, variants, fallback, timeout, and debug state.
9. **Return the applied variant asynchronously.** `runExperiment()` returns a promise that resolves to the activated variant after its synchronous handlers have been invoked.
10. **Expose opt-in diagnostics.** `debug: true` enables lifecycle logs and warnings; production usage is silent by default.
11. **Work as a typed module or browser bundle.** TypeScript consumers can import `runExperiment` and its public configuration types. The minified IIFE build exposes `window.runExperiment` for direct use in a script tag.

### Current boundaries

- An experiment applies once to the elements matching when it runs. The kit does not observe elements added later, revert mutations, or clean up previous effects.
- The default variant must be registered if fallback should perform updates. Otherwise fallback intentionally becomes a no-op.
- Custom functions and element callbacks are synchronous from the kit's perspective: returned promises are not awaited, and a thrown error stops the remaining handlers.
- `innerHTML` is assigned directly and is not sanitized; only pass markup you trust.

## Install and build

```bash
bun install
bun run build
```

This writes the browser bundle to `dist/index.js`. Rebuild only when the TypeScript source changes.

## Quick start

Include the built bundle before the experiment code, then call `runExperiment()` with the feature-flag key and complete variant configuration:

```html
<script>
  // contents of dist/index.js
</script>
<script>
  runExperiment('01-checkout-message-feature-flag', {
    variants: {
      control: [],
      test_group_1: [
        {
          selector: '.checkout-message',
          updates: {
            style: { display: 'block' },
            innerText: 'Free delivery',
          },
        },
      ],
    },
  })
</script>
```

See the [examples](./examples) for complete configurations.

## API

### `runExperiment(featureFlag, options?)`

- `featureFlag`: the PostHog feature-flag key for this experiment.
- `options.defaultVariant`: variant used when PostHog is unavailable, the flag resolves to an unregistered variant, or its value is `false`, `undefined`, or `''`. Defaults to `control`.
- `options.variants`: a map of variant name to its handler. Each handler can be a standalone function or an array containing DOM configurations and standalone functions.
- `options.debug`: enables lifecycle logs and diagnostic warnings for readiness, PostHog resolution, fallback, missing selectors, and application. Defaults to `false`.
- `options.featureFlagTimeoutMs`: total time allowed for an initialized `window.posthog` to become available and deliver its first feature-flag notification. Defaults to `4000` and must be a finite, non-negative number.

It creates and runs the experiment immediately. It returns a `Promise<string>` that resolves to the activated variant after synchronous application finishes:

```js
const activeVariant = await runExperiment('01-checkout-message-feature-flag', {
  variants: {
    control: [],
    test_group_1: [],
  },
})

console.log(activeVariant)
```

### Variant handlers

A variant handler supports three forms.

#### DOM configuration array

```js
runExperiment('product-layout', {
  variants: {
    control: [],
    test: [
      {
        selector: '.product-message',
        updates: {
          style: {
            display: 'block',
            backgroundColor: '#111827',
            padding: '24px',
          },
          innerText: 'Free delivery',
          callback(element, variant) {
            element.dataset.experimentVariant = variant
          },
        },
      },
    ],
  },
})
```

- `selector`: any CSS selector. Updates apply to every matching `HTMLElement`.
- `updates.style`: CSS properties applied with `!important`. camelCase names are converted to kebab-case and CSS custom properties pass through unchanged. Numeric values are stringified without units, so use strings such as `'24px'` where required.
- `updates.innerText`: replaces the element's plain text.
- `updates.innerHTML`: replaces the element's HTML without sanitization.
- `updates.callback(element, variant)`: runs after the declarative updates for each matching element.

#### Standalone function

Use one function when the entire variant needs custom logic:

```js
runExperiment('cart-message', {
  variants: {
    control: [],
    test() {
      document.documentElement.dataset.cartExperiment = 'test'
    },
  },
})
```

#### Mixed configuration and functions

An array can mix DOM configurations and standalone functions. Entries run in array order:

```js
runExperiment('cart-layout', {
  variants: {
    control: [],
    test: [
      {
        selector: '.cart-title',
        updates: { innerText: 'Your new cart' },
      },
      () => {
        document.documentElement.dataset.cartLayout = 'test'
      },
    ],
  },
})
```

## How it works

1. `runExperiment()` creates the internal experiment and starts variant resolution and DOM readiness concurrently.
2. A query parameter matching the feature-flag name takes precedence over PostHog.
3. Otherwise, the kit waits up to `featureFlagTimeoutMs` for an initialized `window.posthog`, listens for its first `onFeatureFlags` notification, then reads `getFeatureFlag(featureFlag)` from the current initialized SDK. This prevents a replaced PostHog bootstrap object from forcing the fallback variant.
4. Boolean `true` maps to `test`; `false`, `undefined`, and `''` map to `defaultVariant`; other strings are used as variant names.
5. If PostHog or its flags miss the deadline, or the resolved variant is not configured, the kit selects `defaultVariant`.
6. At the same time, the kit waits for `DOMContentLoaded`, skipping that wait if the DOM is already ready.
7. Once both are ready, it applies the active variant and resolves the returned promise.

The query-string override bypasses PostHog and its feature-flag deadline. On PostHog success or timeout, the kit clears readiness polling and timers and unsubscribes from PostHog.

## Testing in production

Force a configured variant by adding a query parameter named after the feature flag:

```text
https://example.com/?01-checkout-message-feature-flag=test_group_1
```

This bypasses PostHog, allowing you to test before the flag exists or before your visitor is enrolled.

## Debugging

Debugging is disabled by default. Enable it per experiment:

```js
runExperiment('01-checkout-message-feature-flag', {
  debug: true,
  variants: {
    control: [],
    test_group_1: [],
  },
})
```

Debug output includes readiness progress, query or PostHog resolution, the activated variant, selector match counts, handler counts, completion, and fallback/error warnings. Every message is prefixed with its feature flag:

```text
[Experiment:01-checkout-message-feature-flag] Activated variant 'test_group_1'.
```

The debug option only controls messages emitted by the kit. Logs inside your functions and callbacks are unaffected.

## Commands

```bash
bun install
bun run build
bun run test
```

## Notes

- The browser bundle attaches `runExperiment` to `window`.
- Ensure the page loads `dist/index.js` before calling `runExperiment()`.
