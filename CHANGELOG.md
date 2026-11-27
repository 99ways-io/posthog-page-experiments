# Changelog

All notable changes to this project will be documented here. The project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A short form for one-element tests: `selector` names the element, and a variant can be a text that replaces its text, or `null` for no change.
- `hideUntilReady` hides `selector` from the call until a variant is applied or the default is shown, with `hideTimeoutMs` (default `featureFlagTimeoutMs + maxPageAgeMs`, or `+ 1000` without `maxPageAgeMs`) as the longest hiding time and a CSS fallback 500 ms later that shows the element even if the script stops. Once the element is shown unchanged the run ends: the flag is not read and the visitor is not counted.
- `maxPageAgeMs` counts a visitor only when the page's HTML started arriving no more than that long before the eligibility check. A page already older when the run starts is not hidden, a hidden element is shown as soon as a still-loading page passes this age, and a prerendered page counts from activation. A URL override ignores the time limits, for QA on slow devices.
- A visitor whose page has no element for `selector` is not counted.
- Clear errors for wrong settings: an invalid CSS selector, an empty text variant, a variant of the wrong type, or `hideTimeoutMs` without `hideUntilReady`.

### Fixed

- A PostHog feature-flag notification that arrives after the run has finished no longer reads the flag, so it can never record an exposure for a visitor who was already shown the default. This mattered for PostHog clients that cannot unsubscribe.

### Changed

- The runner also checks `document.readyState` on a short interval while it waits for the page, so consent tools that hold back `DOMContentLoaded` listeners can no longer stall it.

## [0.2.0] - 2026-10-14

### Added

- An assignment summary: every run logs one `console.info` line with the applied variant, its source (`posthog`, `url`, `fallback` or `ineligible`), the raw flag value, PostHog's evaluation reason, the device and distinct IDs, and a plain-language note when the default variant was shown for a specific cause, such as a timeout, an unknown variant or a browser without a PostHog device ID.
- A `log` option: `'summary'` (default), `'debug'` or `'silent'`.
- A `?experiment-debug` URL parameter that turns on debug logs for every experiment on the page, or `?experiment-debug=flag-a,flag-b` for the listed flags only.

### Changed

- The package is no longer silent by default: each run logs its one-line assignment summary. Set `log: 'silent'` to restore the 0.1.0 output. `debug: true` still enables step-by-step diagnostics, as shorthand for `log: 'debug'`.

## [0.1.0] - 2026-09-17

### Added

- Code-first A/B and multivariate page execution backed by PostHog feature flags.
- Eligibility checks that run before feature-flag evaluation.
- Declarative DOM updates and ordered custom functions.
- URL variant overrides for QA.
- Configurable fallback, timeout, and debug behavior.
- ESM, browser/IIFE, and TypeScript declaration builds.
- Unit and real-browser tests using an actual `posthog-js` client.

[0.2.0]: https://github.com/99ways-io/posthog-page-experiments/releases/tag/v0.2.0
[0.1.0]: https://github.com/99ways-io/posthog-page-experiments/releases/tag/v0.1.0
