# Changelog

All notable changes to this project will be documented here. The project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - Unreleased

### Fixed

- The feature flag is read only while PostHog is capturing events: `is_capturing()`, or `has_opted_out_capturing()` on posthog-js releases before 1.260.0. A visitor who withdrew analytics consent while the assignment waited for feature flags used to see the flag's variant without an exposure. PostHog still marked that exposure as sent, so it was not recorded on later page views either, even after the visitor opted in again. The default variant is now applied for that page view (`source: 'fallback'`), and the next page view with capture on assigns the visitor and records the exposure.
- The same applies to visitors PostHog does not capture from the start, for example because of `opt_out_capturing_by_default` or `respect_dnt`: they now receive the default variant on any page view where capture is still off when the flags arrive. To assign them on the page view where they consent, wait for consent in `isEligible`.
- On clients that cannot unsubscribe, feature-flag notifications after a finished run no longer read the flag.

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

[0.2.1]: https://github.com/99ways-io/posthog-page-experiments/releases/tag/v0.2.1
[0.2.0]: https://github.com/99ways-io/posthog-page-experiments/releases/tag/v0.2.0
[0.1.0]: https://github.com/99ways-io/posthog-page-experiments/releases/tag/v0.1.0
