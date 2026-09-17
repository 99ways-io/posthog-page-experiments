# Agent guidance

Read `README.md` before changing code. It is the source of truth for the product's public purpose, API, and boundaries.

## Scope

This is a small browser execution layer for code-first PostHog page experiments. Keep PostHog responsible for assignment and analysis. Do not expand the project into a visual editor, analytics SDK, or framework suite without explicit direction and evidence of demand.

`runExperiment()` is the public runtime API. The internal implementation class is not a public semver contract.

## Commands

```bash
bun install
bun run typecheck
bun run test:unit
bun run test:browser
bun run build
bun run check:package
```

When `src/` changes, run typecheck, unit tests, browser tests, and build. When packaging or exports change, also inspect `npm pack --dry-run` output and run `publint`.

## Correctness rules

- Eligibility must finish before PostHog evaluates the feature flag.
- Ineligible visitors must not be assigned an active variant by this package.
- Preserve safe, explicit fallback behavior.
- Keep the module entry side-effect-free; only `src/browser.ts` creates `window.runExperiment`.
- Examples must be neutral and must not contain client domains, selectors, identifiers, copy, or storage keys.
- Do not publish to npm, create a public release, or change repository visibility without the owner's explicit instruction.
