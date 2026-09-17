# PostHog Page Experiments

Code-first page experiments for PostHog. Apply A/B and multivariate variants to existing websites with eligibility checks, URL QA overrides, and safe fallbacks.

Use it when PostHog should handle assignment and analysis, but the tested experience lives in an existing page that you need to change with JavaScript or targeted DOM updates.

> [!NOTE]
> This is an independent community project from [99Ways](https://99ways.io). It is not affiliated with or endorsed by PostHog.

## Why it exists

A direct `posthog.getFeatureFlag()` call is enough for a simple product branch. Page experiments tend to repeat more browser-side work:

- wait for the page and PostHog to become ready;
- exclude visitors who cannot receive the change before recording an exposure;
- map variants and apply several DOM or custom-code steps;
- fall back safely when a flag is late, disabled, or misconfigured;
- let reviewers force a variant through the URL.

PostHog Page Experiments packages that execution logic without replacing PostHog's feature flags, experiment analysis, or no-code tools.

## Install

```bash
npm install @99ways/posthog-page-experiments posthog-js
```

The package has no runtime dependencies. It works with an existing PostHog browser client, whether you pass that client directly or expose it as `window.posthog`.

## Quick start

```ts
import { runExperiment } from '@99ways/posthog-page-experiments'
import posthog from 'posthog-js'

posthog.init('YOUR_PROJECT_KEY', {
  api_host: 'https://us.i.posthog.com',
})

const activeVariant = await runExperiment('pricing-page-headline', {
  posthog,

  // Checked before PostHog evaluates the flag. Ineligible visitors return null
  // and are not included in the experiment by this call.
  isEligible: () => document.querySelector('.pricing-hero') !== null,

  variants: {
    control: [],
    test: [
      {
        selector: '.pricing-hero h1',
        updates: {
          innerText: 'A clearer reason to choose the product',
        },
      },
    ],
  },
})

console.log(activeVariant) // 'control', 'test', another configured variant, or null
```

The default variant must be present in `variants`. An empty `control: []` keeps the original page unchanged while making fallback behavior explicit.

### Direct browser script

After `0.1.0` is published, the minified browser build will be available from npm CDNs:

```html
<script src="https://cdn.jsdelivr.net/npm/@99ways/posthog-page-experiments@0.1.0/dist/posthog-page-experiments.min.js"></script>
<script>
  window.runExperiment('pricing-page-headline', {
    isEligible: () => document.querySelector('.pricing-hero') !== null,
    variants: {
      control: [],
      test: [
        {
          selector: '.pricing-hero h1',
          updates: { innerText: 'A clearer reason to choose the product' },
        },
      ],
    },
  })
</script>
```

Load PostHog before the experiment code, or let the package wait up to `featureFlagTimeoutMs` for a late-loading `window.posthog` client.

## Protect experiment validity with eligibility

PostHog records an experiment exposure when your code evaluates the flag. If a visitor cannot receive the page change—because the relevant page, state, or element is absent—evaluate that condition first:

```ts
runExperiment('checkout-reassurance', {
  isEligible: async () => {
    const checkout = document.querySelector('[data-checkout]')
    const hasExistingOrder = await hasCompletedOrder()
    return checkout !== null && !hasExistingOrder
  },
  variants: {
    control: [],
    test: [
      {
        selector: '[data-checkout-reassurance]',
        updates: { innerText: 'Free returns within 30 days' },
      },
    ],
  },
})
```

`isEligible` runs after `DOMContentLoaded` and before the URL override or PostHog is read. It may be synchronous or asynchronous. A false result resolves `runExperiment()` to `null`; an error rejects the promise without evaluating the flag.

Eligibility should describe who can actually receive the tested experience. It is not a replacement for audience targeting in PostHog.

## QA a variant through the URL

Add a query parameter whose name is the feature-flag key:

```text
https://example.com/pricing?pricing-page-headline=test
```

A configured URL variant takes precedence over PostHog, which makes review possible before a rollout exists. Eligibility still runs first. An unknown variant falls back to the configured default.

## Choose the right tool

Use this package when:

- you are changing an existing server-rendered or static page;
- the variant needs a few DOM changes or custom browser functions;
- PostHog already owns assignment and experiment analysis;
- eligibility, fallback, and repeatable QA matter.

Use raw PostHog feature-flag calls when the flag is already part of your application's render logic. Use PostHog's no-code tooling when the change can be authored and maintained there without custom execution logic. This package is deliberately not a visual editor, framework wrapper, or experiment-analysis SDK.

## API

### `runExperiment(featureFlag, options)`

Returns `Promise<string | null>`:

- the applied variant name when the visitor is eligible;
- `null` when browser globals are unavailable or `isEligible` returns false.

The promise rejects if eligibility or a variant handler throws.

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `variants` | `Record<string, VariantHandler>` | Required | Complete map of supported variants. Must include the default. |
| `defaultVariant` | `string` | `control` | Used for unavailable, disabled, empty, timed-out, or unknown flag values. |
| `isEligible` | `() => boolean \| PromiseLike<boolean>` | `() => true` | Runs before the flag is evaluated. |
| `posthog` | `PostHogClient` | `window.posthog` | Explicit initialized client for module use. |
| `featureFlagTimeoutMs` | `number` | `4000` | Maximum wait for PostHog and its first feature-flag notification. |
| `debug` | `boolean` | `false` | Enables lifecycle and fallback diagnostics. |

Boolean flags map `true` to `test` and `false` to the default variant. String-valued flags map directly to the matching configured variant.

### Variant handlers

A variant can be one function or an ordered array containing DOM changes and functions:

```ts
runExperiment('offer-card', {
  variants: {
    control: [],
    test: [
      {
        selector: '.offer-card',
        updates: {
          style: {
            backgroundColor: '#111827',
            color: '#ffffff',
            padding: '24px',
          },
          innerText: 'A focused offer',
          callback(element, variant) {
            element.dataset.experimentVariant = variant
          },
        },
      },
      () => {
        document.documentElement.dataset.hasOfferExperiment = 'true'
      },
    ],
  },
})
```

- Every matching element is updated.
- Style names may be camelCase, kebab-case, or CSS custom properties. Values are stringified and applied with `!important`; include units such as `'24px'` when needed.
- `innerText` replaces plain text.
- `innerHTML` is assigned without sanitization. Only use trusted markup.
- Element callbacks and custom functions run synchronously in array order. Returned promises are not awaited.

## Flicker and loading strategy

This package waits for DOM readiness, eligibility, and the PostHog flag before changing the page. A client-rendered visual treatment can therefore flash the original experience.

For visible above-the-fold changes:

1. load PostHog and the experiment code as early as your performance budget allows;
2. bootstrap or cache PostHog flags when your architecture supports it;
3. hide only the specific experiment target with a short, fail-safe timeout when a flash would be worse than a brief concealment;
4. prefer server-side or application-rendered variants when flicker-free rendering is essential.

The package does not inject a global anti-flicker snippet because a generic page-hiding strategy can damage Core Web Vitals and trap content when scripts fail.

## Current boundaries

- Variants apply once. The package does not observe later SPA mutations, revert changes, or clean up effects.
- Selectors that match nothing are skipped. Use `isEligible` when a missing target means the visitor must not enter the experiment.
- Handlers are synchronous from the package's perspective; asynchronous work inside them is not awaited.
- A thrown handler error stops the remaining steps and rejects the returned promise.
- The package runs in browsers. Importing it during server rendering is safe, but calling it without browser globals resolves to `null`.

## Try the local demo

```bash
bun install
bun run demo
```

Open the URL printed in the terminal. The demo uses the same URL override as production QA, so it works without a PostHog account.

More neutral examples are in [`examples/`](./examples).

## Development

```bash
bun install
bun run typecheck
bun run test
bun run build
bun run check:package
```

Unit tests cover the execution contract. Playwright loads the shipped IIFE bundle in Chromium with an actual `posthog-js` client.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for contribution guidance and [SECURITY.md](./SECURITY.md) for private vulnerability reporting.

## License

[MIT](./LICENSE) © 99Ways
