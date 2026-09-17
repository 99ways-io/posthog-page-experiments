# Contributing

Focused fixes, tests, documentation improvements, and small execution-layer features are welcome.

Before opening a pull request:

```bash
bun install
bun run typecheck
bun run test
bun run build
bun run check:package
```

Keep the package narrow. It delegates audience assignment and analysis to PostHog; it should not become a visual editor, analytics SDK, or framework abstraction without demonstrated user demand.

For behavior changes, add a test that exercises the public `runExperiment()` contract. For browser-specific behavior, test the shipped bundle in Playwright. Update the README when users need to understand a new option, boundary, or migration.

By contributing, you agree that your contribution is licensed under the repository's MIT license.
