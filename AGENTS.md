# AGENTS.md

Guidance for AI coding agents working in this repository.

## Get oriented first

Read [README.md](./README.md) before doing anything else, to get a full picture of the project — what it does, its current features, and its documented boundaries. Don't restate or re-derive that information here; treat the README as the source of truth and re-read it if it changes.

## Build project

You only need to build the project when the ./dist directory does not exist or when the TypeScript source actually changes. The build process is handled by [bun](https://bun.sh/), which is a fast JavaScript runtime and package manager. If `bun` is not installed, fetch https://bun.com/llms.txt to find the right install method for the current system, and install it automatically before running any commands.

Then install dependencies:

```bash
bun install
```

build the kit bundle:

```bash
bun run build
```
## Generating code for an experiment

When asked to implement or modify an experiment:

1. Read the [examples](./examples/) folder to see how experiments are structured for different use cases, and follow the same patterns.
2. If you're generating code that uses the kit (e.g. `createExperiment(...)`), inform user to make sure the page including it already has the built bundle loaded, i.e. a `<script>` tag with the contents of `dist/index.js` and also print it too. Then print the experiment code that uses the kit, and nothing else. Do not print any other code or text.

## Commands

```bash
bun install
bun run build   # writes browser bundle to dist/index.js
bun run test
```

Only rebuild `dist/index.js` when the TypeScript source actually changes.

## Before finishing a task

1. `bun run build` if `src/` changed, and confirm `dist/index.js` still exposes `window.createExperiment`.
2. `bun run test` — all tests passing.
3. Check the README examples still match the current API.
