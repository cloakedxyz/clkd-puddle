<!-- brand:start -->
# puddle
<!-- brand:end -->

Motivation: [article](https://substack.com/home/post/p-218397149) - Published Oct 2nd 2026

Fund a RAILGUN or Privacy Pools private balance with a normal token transfer.
Send to a `0x` deposit address; a relayer handles the pool deposit.

**Proof of concept. Unaudited. Test funds only.**

## Use cases

- Fund your private wallet without manually shielding.
- Receive payments from people who don't use a privacy wallet.
- Accept payouts from apps that send ordinary token transfers.

## Supported protocols

| Protocol | Contracts & SDK | Website release |
| --- | :---: | --- |
| [RAILGUN](https://railgun.org/) | ✅ | First release · local preview available |
| [Privacy Pools v1](docs/src/pages/privacy-pools-v1.md) | ✅ | Coming soon |
| [Privacy Pools v2](docs/src/pages/privacy-pools.md) | ✅ | Coming soon |

All integrations are tested locally. The standalone recovery tool supports all three,
including the v1 public pool exit.

## Public website

The first real-deposit route is **RAILGUN, WETH, Ethereum**. The public landing page
shows this launch plan and marks Privacy Pools v1 and v2 coming soon. Deposits are
not open yet; the local test interface is excluded from the public build.

Import `cloakedxyz/clkd-puddle` into Vercel as `clkd-puddle`, using the repository
root and `main` as the production branch. `vercel.json` sets the install command,
`npm run build:site` and the `dist` output directory. This builds the landing page
at `/` and the docs at `/docs` in one project. Use Node.js 24. Add `puddle.link`
in the project's Domains settings and apply the DNS records Vercel provides.
No environment variables or wallet keys are needed for the landing page.

Vercel's GitHub integration deploys pushes to `main` and creates branch previews.
GitHub Actions runs the tests; no separate deployment action or Vercel token is
needed in GitHub. Run `npm run test:site` to check the public build locally.
The real-deposit service remains separate work tracked in [the roadmap](ROADMAP.md).

## Run locally

Requires Node.js 24.12+, Git and [Foundry](https://getfoundry.sh/) 1.7.1.

```sh
npm ci --ignore-scripts
npm ci --prefix docs --ignore-scripts
npm run setup:contracts
npm run privacy-pools-v1:setup
npm run dev
```

[App](http://127.0.0.1:5173) · [Docs](http://127.0.0.1:5174) · [Recovery](http://127.0.0.1:5175)

The landing page previews RAILGUN with test USDC. Privacy Pools v1 and v2 are marked
**Coming soon**. Save the recovery file, send test funds, then press **Relay deposit
manually**. Before relaying, funds can be recovered from the receiving address.

Developers can opt into the existing Privacy Pools v1 experiment with
`PUDDLE_EXPERIMENTAL_V1=1 npm run dev`. It accepts a public receive code from a
recipient wallet for the demo's local chain and pool, and supports a public pool
exit. It never generates or imports the wallet's secrets. Use the Sepolia page
below for Cloaked's Sepolia export.
Restarting clears the local chain. Use `npm run demo` for a terminal-only run.

## Sepolia with Cloaked

After the setup above, run `npm run dev:sepolia` and open
[the Sepolia page](http://127.0.0.1:5176). It uses the public deployment configuration
in [deployments/sepolia.json](deployments/sepolia.json); the server holds no wallet keys.

In Cloaked's local test build, enable the team-only receive-code flag and choose
**Settings → Generate Puddle Code**. Paste the fresh code into Puddle, save the public
recovery file and send the displayed amount of Sepolia ETH. Creating an address does
not require connecting a wallet. Manual relay requires the configured relay wallet;
recovery requires the wallet named in the code. Share the recovery file with its owner.
Never reuse a code, even if you abandon a receiving address.

A real Sepolia deposit was recognised by Cloaked and publicly recovered to its fixed
recovery wallet. Both recovery paths are covered locally; a separate live test of
receive-address recovery remains outstanding. Cloaked's secure UI currently handles
pool recovery only. Keep the matching source and recovery build for this deployment.

## Design

All protocols share fee limits, single-use execution, CREATE2 deployment and
owner recovery. Each deposit is a fixed ERC-1167 clone. Small adapters build or
validate each pool's deposit call.

An address fixes its recipient instructions, recovery owner, relayer and fee
recipient. Quotes supply token, amount, gas charge and expiry separately. RAILGUN
permits changing token and amount; Privacy Pools v2 must preserve its prepared proof's
private deposit. Fees are **0.1% plus a capped gas charge**, with pool fees on top.
Fees are collected only when the deposit succeeds.

Standard ERC-20 tokens; Privacy Pools v1 also supports native ETH. V1 fixes the asset,
pool and recipient-generated deposit hash. Initial transfers are public; reusing a recovery
address links deposits. Excess and late funds stay owner-recoverable. Puddle has
no admin setters or upgrades; the underlying pools have their own governance.

| Path | Purpose |
| --- | --- |
| `contracts/` | Shared settlement and protocol adapters |
| `protocols/` | TypeScript preparation, quotes and execution |
| `client/` | Public receive SDK; separate private recovery and Node RAILGUN entry points |
| `app/`, `recovery/` | Local demo and independent recovery website |
| `test/` | Solidity and real-protocol integration tests |

[Contracts & security](docs/src/pages/contracts.md) · [Fees](docs/src/pages/fees.md) ·
[Recovery](recovery/README.md) · [API and cross-chain design](DESIGN.md) · [Roadmap](ROADMAP.md)

## Development

```sh
npm run check                         # Types, contracts, integrations, UI, recovery, docs
FOUNDRY_PROFILE=ci npm run test:contracts  # Deeper fuzz and transaction-sequence tests
```

V1's real-contract, proof and browser recovery tests run in `npm run check` and public CI.
Run `npm run privacy-pools-v1:setup` after installing root dependencies. The browser
test uses installed Google Chrome on macOS; elsewhere run `npx playwright install chromium`.
Proof files are pinned and checked against upstream SHA-256 hashes; no real funds are used.

Privacy Pools v2 proof tests additionally require pnpm, Git LFS and access to the
currently private upstream repository: `npm run privacy-pools:setup`, then
`npm run test:privacy-pools`. Public CI tests the v2 contract adapter without that SDK.

`npm run test:fork` uses a recent Arbitrum block and prints it for reproduction.
Set `FORK_BLOCK` to pin it and `ARBITRUM_RPC_URL` for an archive RPC. No real transactions are sent.

Keep contributions focused, add tests for behavior changes and run `npm run check`.
See [security notes](SECURITY.md) for limits and dependency advisories.

Branding lives in [brand.json](brand.json). Run `npm run rename -- new-name`;
add `--github` to rename the repository too. The product name and GitHub repository
name are independent. Rebuild afterward. Both sites show their
built commit; `dev` marks local changes. Source archives can set `BUILD_COMMIT`.

## License

[MIT](LICENSE) for original code. Dependencies and logos retain their own terms,
including `circomlibjs` and `snarkjs` (GPL-3.0); see [asset credits](app/assets/README.md).
Pinned upstream contracts and generated artifacts are not redistributed here.
