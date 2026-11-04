# Release checklist

An open-source review candidate does not approve public funds. Current evidence and
remaining security gates are in [RELEASE.md](../RELEASE.md).

1. Review the exact source, dependencies and licenses. Run from a clean checkout:

   ```sh
   npm ci --ignore-scripts
   npm run setup
   npm run check
   npm run test:sdk-package
   npm audit --prefix sdk --omit=dev
   git diff --check
   ```

2. Build after the final edits and inspect the package:

   ```sh
   npm run build:sdk
   npm pack ./sdk --dry-run
   npm pack ./sdk --pack-destination .cache/release
   ```

   The consumer check creates `.cache/release/`. Default packing runs the build
   guard. Do not disable scripts during packing. The root package is private.

3. Check exports, declarations, example, contract artifact, build hashes, version,
   license/notices and the exact tarball digest. Exclude private profiles, recovery
   files, secrets, test code and full wallet/proving tools. Review source and Git
   history for secrets before changing repository visibility.
4. Confirm namespace, version, reviewed source and prerelease tag with a maintainer.
   Publish only the inspected artifact through the approved authentication flow.
   No automatic publishing workflow is configured.
5. Verify a fresh registry install after publication and record its digest/tag.

Before public deposits: resolve independent review findings, complete the exact live
Kernel/RAILGUN wallet and recovery checks, verify deployed source, distribute matching
recovery artifacts, and operate reliable automatic relaying with realistic gas quotes.
Bridge routes additionally need funded success/refund/failure validation.

For the manually operated website, build the SDK, then set
`PUDDLE_SITE_CONFIGURATION` to the reviewed Arbitrum site JSON and run
`npm run build:site`. The build requires matching deployed contract code and fails
before replacing output if that verification fails. It includes the receiving app,
public deployment pins, exact runtime templates and the current SDK API docs.
The operator can restore a funded recovery file and relay from its wallet. No
operator key or Relay API key belongs in this static deployment. Bridge routes stay
disabled until their funded recovery tests pass. Without a configuration, the build
publishes only the landing page and docs. Verify the deployed domain after updating it.

For a static host without Foundry or the SDK build cache, first run
`node scripts/site-release.ts REVIEWED_PUBLIC_CONFIGURATION NEW_RELEASE_JSON`
locally after building the SDK. This read-only preflight writes public configuration,
runtime templates and source hashes, with no recipient or recovery profile. Review it
against the independently compiled SDK, then build the host checkout with
`PUDDLE_SITE_RELEASE=NEW_RELEASE_JSON npm run build:site`. Changed source or deployed
code fails the build. This handoff does not approve opening public deposits; keep
the default landing-only build until the security gates above are satisfied.

The optional live planner reads public chain state and executes only on an isolated
local fork. It never reads keys or sends public transactions:

```sh
node scripts/plan-live.ts PUBLIC_PROFILE_JSON NEW_PRIVATE_OUTPUT_DIRECTORY MAX_NATIVE_ETH
```

Its profile contains `recipient`, `recovery` and `relayer`; this pilot expects recovery
and relayer to be the same selected owner. Save the profile and output under ignored
`.cache/`. The output includes a recovery file, reviewed configuration, exact transaction
plan and digest. Approval must identify that plan and spending cap; changed source,
deployment state, fee conditions or wallet nonce require another review before sending.
