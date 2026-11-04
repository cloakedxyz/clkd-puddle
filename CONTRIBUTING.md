# Contributing

Read the [architecture](docs/architecture.md), [security notes](SECURITY.md) and
[agent guide](AGENTS.md) first. Keep the repo focused on ZeroDev Kernel + RAILGUN.

## Setup and checks

```sh
npm ci --ignore-scripts
npm run setup
npx playwright install --with-deps chromium
npm run check
npm run test:sdk-package
```

Use Node 24 and Foundry 1.7.1. Browser tests use installed Google Chrome on macOS;
Linux uses Playwright Chromium. Setup downloads pinned public sources. No private
upstream access, wallet credentials or funded account is needed.

`npm run check` runs source-file hygiene, documentation/configuration formatting,
strict TypeScript, Solidity tests, real protocol integration, browser and site checks.
`test:sdk-package` installs the actual tarball outside the checkout and checks its
exports, declarations, example and browser bundle. Use `FOUNDRY_PROFILE=ci npm run
test:contracts` for deeper fuzzing.

## Changes

Keep changes small and readable. Use existing TypeScript style, strict types and
meaningful tests for behavior changes. Run `npm run format` for Markdown/configuration
and `git diff --check` before review. Explain the problem, resulting behavior, tests
and remaining limitations in the pull request.

Keep dependencies exact, update lockfiles and review licenses. Avoid forced dependency
upgrades. Never commit recipient profiles, recovery files, wallet secrets, signing
journals or generated output. The repository check is a small guard, not a complete
secret scanner or Git-history scan.

Follow the [code of conduct](CODE_OF_CONDUCT.md). Report vulnerabilities using
[SECURITY.md](SECURITY.md#reporting). Publication and live transactions are separate
maintainer actions; see the [release checklist](docs/releasing.md).
