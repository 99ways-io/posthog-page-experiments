# A/B Experiment Kit

A small kit for running A/B experiments backed by PostHog feature flags. Define what each variant should do to the DOM (or run arbitrary code), and the kit resolves the user's variant from PostHog, waits for the DOM to be ready, then applies it.

## What it can do today

Listed from the kit's primary purpose down to supporting conveniences:

1. **Run PostHog-backed A/B and multivariate experiments.** It resolves string variants such as `control`, `test_group_1`, or `test_group_2` through `window.posthog`. Boolean flags follow the convention `true` → `test` and `false` → the configured default variant.
2. **Apply declarative DOM variations.** A variant can target any CSS selector, update every matching element, set inline styles with `!important`, replace `innerText`, or replace `innerHTML` with trusted markup.
3. **Fail safely to a known experience.** Late or non-responsive PostHog initialization, empty or disabled flags, and variant names that are not configured fall back to `control` or a custom `defaultVariant` after a configurable deadline.
4. **Force variants through the URL for QA.** A query parameter named after the feature flag takes precedence over PostHog, allowing a configured variant to be previewed before its PostHog flag or rollout exists.
5. **Support both inline and fluent configuration.** Variants can be supplied in the `variants` option, registered with chainable `.on(variant, handler)` calls, or assembled using both forms. Multiple handlers can be attached to the same variant.
6. **Run custom experiment logic on the dom or global scope.** Each time an active variant is applied, element callbacks run for every selector match and receive both the element and active variant. Plain function handlers run once per registration for work that is not tied to a selector.
7. **Coordinate PostHog, flag, and DOM readiness.** As soon as an experiment is created, the kit caches a readiness promise that waits for a late-loading initialized PostHog instance and its first feature-flag notification while also awaiting `DOMContentLoaded`. The first notification resolves readiness and its listener is removed; if the overall deadline expires first, the default variant becomes the candidate.
8. **Run multiple independent experiments on the same page.** Each experiment keeps its own feature flag, variants, default, handlers, and readiness state.
9. **Return the applied variant asynchronously.** `.run()` returns a promise containing the selected variant after its handlers have been invoked. Repeated calls return the same promise and do not reapply the handlers.
10. **Expose opt-in diagnostics.** `debug: true` enables lifecycle logs plus warnings for PostHog availability, subscription, flag-reading, and cleanup errors, unknown variants, missing default configurations, and selectors with no matches; production usage is silent by default.
11. **Work as a typed module or small browser bundle.** The TypeScript source exports `Experiment`, `createExperiment`, and its public configuration types. The minified IIFE build exposes `window.createExperiment` for direct use in a script tag.

### Current boundaries

- The first `.run()` applies the active handlers to the elements matching at that moment. The kit does not observe elements added later, revert mutations, or clean up previous effects.
- Readiness and the feature-flag deadline begin at experiment construction, even if `.run()` is called later. Variant validation and DOM application still happen only when `.run()` is called.
- The default variant must be registered if it needs to perform updates. Otherwise fallback intentionally becomes a no-op.
- Custom handlers are synchronous from the kit's perspective: returned promises are not awaited, and a thrown error stops the remaining handlers for that run.

## Install & build

```bash
bun install
bun run build
```

This writes the browser bundle to `dist/index.js`. You only need to rebuild when the source changes. Reuse the existing `dist/index.js` if you didn't change the source.

## Quick start

Include the built bundle in your page, then create an experiment and pass the inline variants to it.

```html
<script>
  // contents of dist/index.js
</script>
<script>
  createExperiment('01-checkout-message-feature-flag', {
    debug: false,
    featureFlagTimeoutMs: 4000,
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
  .run()
</script>
```

Variants can also be registered on the experiment via `.on()`:

```js
const experiment01 = createExperiment('01-checkout-message-feature-flag')
  .on('control', [])
  .on('test_group_1', [
    {
      selector: '.checkout-message',
      updates: {
        style: { display: 'block' },
        innerText: 'Free delivery',
      },
    },
  ])
experiment01.run()
```

Both forms are equivalent. `.on()` is just sugar for adding entries to `variants`. You can also mix them (register some variants via inline config, add more via `.on()`). Register all handlers before calling `.run()`; the first call to `.run()` locks the configuration and subsequent `.on()` calls throw an error.

See the [examples](./examples) for more.

## API

### `createExperiment(featureFlag, options?)`

- `featureFlag`: the PostHog feature flag key for this experiment.
- `options.defaultVariant`: variant to fall back to when PostHog is unavailable, the flag resolves to an unregistered variant, or the flag value is `false`/`undefined`/`''`. Defaults to `'control'`. Optional.
- `options.variants`: a map of variant name → handler, registered up front. Optional.
- `options.debug`: enables lifecycle logs and diagnostic warnings for PostHog availability, subscription, flag-reading, and cleanup errors, unknown variants, missing default configurations, and unmatched selectors. Defaults to `false`. Optional.
- `options.featureFlagTimeoutMs`: total time from experiment construction allowed for an initialized `window.posthog` to become available and deliver its first feature-flag notification. Defaults to `4000`. Must be a non-negative, finite number of milliseconds. Optional.

Returns an `Experiment` instance.

### `.on(variantName, handler)`

Registers a config/handler for a variant. Can be called multiple times for the same variant name and is chainable.

A handler is either:
- **An array of DOM updates** (`VariationUpdate[]`), each with:
  - `selector`: a CSS selector; the update applies to every matching element. If nothing matches, that update is skipped and a warning is logged when `debug` is enabled.
  - `updates.style`: an object of CSS properties to set with `!important`. camelCase keys (`backgroundColor`) are converted to kebab-case automatically; custom properties (`--my-var`) are passed through as-is. Numbers are stringified without adding units, so use strings such as `'24px'` where CSS requires a unit.
  - `updates.innerText` / `updates.innerHTML`: set directly on the element if provided.
  - `updates.callback(element, variant)`: called per matched element with the element and the active variant name. You can use it for anything that declarative options (`styles, innerText, innerHTML`) don't cover.
- **A plain function**: called once with no arguments, for logic that isn't tied to a selector at all.

#### Example

```js
const exp = createExperiment('01-checkout-message-feature-flag');
// array of DOM updates
exp.on('test_group_1', [
  // update 1
  {
    selector: '.checkout-message',
    updates: {
      style: { display: 'block' },
      innerText: 'Free delivery',
    },
  },
  // update 2
  {
    selector: '.checkout-message',
    updates: {
      callback(el, variant) {
        // This is a callback that runs for every element matched by the selector.
        // you can manipulate the element however you want, and you have access to the active variant name.
        console.log('variant', variant, 'applied to', el);
      },
    },
  },
]);

// callback that runs once, not tied to any selector
exp.on('test_group_2', () => {
  // This is a plain function handler, not tied to any selector.
  console.log('test_group_2 applied');
});
```

### `.run()`

Waits for the readiness promise already cached by the constructor, validates and applies the selected variant, and returns a promise that resolves to its name after the synchronous handlers have been invoked. The first call locks variant registration. Later calls return the same promise without applying the handlers again.

## How it works

1. **Resolve the variant and wait for the DOM concurrently.** Readiness begins when `createExperiment()` constructs the experiment, and variant resolution follows this order:
   - A query parameter matching the feature flag name, if present (see "Testing in production" below).
   - Otherwise, wait up to `featureFlagTimeoutMs` for an initialized `window.posthog`, then listen for its first `onFeatureFlags` notification and read `getFeatureFlag(featureFlag)`. A flag value of `true` maps to `'test'`; `false`, `undefined`, or `''` maps to `defaultVariant`; any other string is used as-is.
   - If PostHog or its feature flags are not ready before the same overall deadline, the experiment falls back to `defaultVariant` and logs a warning when `debug` is enabled.
   At the same time, the experiment waits for `DOMContentLoaded`, skipping that wait if the DOM is already ready.
2. **Validate**: if the resolved variant has no registered handler, `defaultVariant` is used instead and a warning is logged when `debug` is enabled.
3. **Apply** every update/handler registered for the active variant when `.run()` is called.

### Configuring the feature-flag deadline

The default four-second deadline starts at experiment construction and covers both PostHog becoming initialized and its feature flags becoming ready. Override it per experiment when the host page has different loading expectations:

```js
createExperiment('01-checkout-message-feature-flag', {
  featureFlagTimeoutMs: 6000,
  variants: {
    control: [],
    test_group_1: [],
  },
}).run()
```

The query-string override bypasses PostHog and therefore does not wait for this deadline. On success or timeout, the kit clears its readiness polling and timeout and unsubscribes from PostHog.

## Testing in production

Force a specific variant by adding a query parameter named after the feature flag:

```js
createExperiment('01-checkout-message-feature-flag').on(/* ... */).on(/* ... */).run()
```
The URL would look like this:
```
https://example.com/?01-checkout-message-feature-flag=test_group_1
```

This bypasses PostHog entirely, so it works even for flags you're not enrolled in yet. It also works for flags that don't exist yet, so you can test your experiment before the flag is created in PostHog.

## Debugging

Debugging is disabled by default. Enable it for an individual experiment while developing or validating its configuration:

```js
createExperiment('01-checkout-message-feature-flag', {
  debug: true,
  variants: {
    control: [],
    test_group_1: [],
  },
}).run()
```

When enabled, the experiment logs handler registration, readiness progress, query/PostHog resolution, the activated test group, selector match counts, and application completion. It also emits warnings for timeout, fallback, subscription, cleanup, and missing-selector conditions.

Every message is prefixed with the feature flag, for example:

```text
[Experiment:01-checkout-message-feature-flag] Activated variant 'test_group_1'.
```

The debug flag only controls logs emitted by the experiment. Logs inside your own variant functions and element callbacks are unaffected.

## Commands

```bash
bun install
bun run build
bun run test
```

## Notes

- The bundle attaches `createExperiment` to `window`, so it's available globally once the script tag runs.
