# Changelog

All notable changes to this project will be documented here. The project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
