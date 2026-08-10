# A/B Experiment SDK

A small browser SDK for running A/B experiments backed by PostHog feature flags. Define what each variant should do to the DOM (or run arbitrary code), and the SDK resolves the user's variant from PostHog, waits for the DOM to be ready, then applies it.

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

Both forms are equivalent. `.on()` is just sugar for adding entries to `variants`. You can also mix them (register some variants via inline config, add more via `.on()`). When you run the experiment (`.run()`), you are not able to add more variants via `.on()` anymore.

See the [examples](./examples/README.md) for more.

## API

### `createExperiment(featureFlag, options?)`

- `featureFlag`: the PostHog feature flag key for this experiment.
- `options.defaultVariant`: variant to fall back to when PostHog is unavailable, the flag resolves to an unregistered variant, or the flag value is `false`/`undefined`/`''`. Defaults to `'control'`. Optional.
- `options.variants`: a map of variant name → handler, registered up front. Optional.

Returns an `Experiment` instance.

### `.on(variantName, handler)`

Registers a config/handler for a variant. Can be called multiple times for the same variant name and is chainable.

A handler is either:
- **An array of DOM updates** (`VariationUpdate[]`), each with:
  - `selector`: a CSS selector; the update applies to every matching element. If nothing matches, a warning is logged and that update is skipped.
  - `updates.style`: an object of CSS properties to set with `!important`. camelCase keys (`backgroundColor`) are converted to kebab-case automatically; custom properties (`--my-var`) are passed through as-is.
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

Resolves the variant, applies it and returns the resolved variant name.

## How it works

1. **Resolve the variant**, in order:
   - A query parameter matching the feature flag name, if present (see "Testing in production" below).
   - Otherwise, `window.posthog.getFeatureFlag(featureFlag)`, once PostHog's flags are ready. A flag value of `true` maps to `'test'`; `false`, `undefined`, or `''` maps to `defaultVariant`; any other string is used as-is.
   - If `window.posthog` isn't available or doesn't expose `onFeatureFlags`/`getFeatureFlag`, the SDK logs a warning and falls back to `defaultVariant`.
2. **Validate**: if the resolved variant has no registered handler, a warning is logged and `defaultVariant` is used instead.
3. **Wait for `DOMContentLoaded`** (skipped if the DOM is already ready).
4. **Apply** every update/handler registered for the active variant.

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

## Commands

```bash
bun install
bun run build
bun run test
```

## Notes

- The bundle attaches `createExperiment` to `window`, so it's available globally once the script tag runs.
