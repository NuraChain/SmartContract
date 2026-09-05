# Contract Manager

A transparent administrative interface for the smart contracts deployed to
**Nura Chain** (EVM, chain id **1020**). Connect a wallet, inspect the supported
contracts, read their state with static calls, and execute their write functions
through your own wallet - with every parameter shown before anything is signed.

Built on **AzerothJS 2** (`.azeroth` single-file components) on **Vite 8**,
**TypeScript 6**, **TailwindCSS 4**, and **viem**. There is no React, no backend,
no indexer, and no key storage: reads go straight to the RPC, writes are signed
by the connected wallet.

## The registry is the source of truth

`application/src/config/contracts.ts` is the single list of contracts this app
can talk to. No component hardcodes an address or an ABI.

```ts
{
    id: 'bridge-usdt',                    // URL slug + activity-log reference
    name: 'BridgeUSDT',
    description: '...',
    category: 'token',
    folder: 'token',                      // contracts/<folder> in the contracts repo = its section
    chainId: 1020,
    address: '0x4E0D...',                 // null = no deployment on record
    abi: BridgeUsdtAbi,                   // compiled artifact from the repo
    staticCallables: ['quoteExactInput']  // optional: revert-to-answer functions
}
```

ABIs come from the contracts repository's Hardhat artifacts and are refreshed
with:

```sh
npm run extract:abi        # ARTIFACTS_DIR env var overrides the source path
```

An entry with `address: null` is listed honestly as "no deployment recorded" -
never guessed. When a deployment lands, record its address there and the whole
app picks it up.

The contracts page is one section per folder of the contracts repository
(`contracts/token`, `contracts/airdrop`, `contracts/univ3`, `contracts/vault`,
`contracts/forecast`, `contracts/profile`, plus `contracts/testing` for the
wrapped-native coin and a section for shared chain infrastructure the repository
does not build). `FOLDERS` in the same file describes each section - path,
description, deploy command - and every entry's `folder` files it under one.
Adding a folder to the contracts repository means adding a `FOLDERS` entry here.

## Architecture

```
config/chain.ts         one network definition (id 1020, RPC, explorer)
config/contracts.ts     the contract registry (above)
lib/abi.ts              ABI -> function descriptors -> forms -> parsed args
lib/chain-client.ts     public client (reads) + on-chain code probe
lib/wallet/store.ts     EIP-6963 discovery, connection, switch/add chain
lib/tx-manager.ts       prepare (gas + revert decode) -> submit -> receipt
lib/history.ts          local activity log (non-sensitive metadata only)
lib/errors.ts           one error taxonomy for wallet/RPC/revert failures
components/wallet/      connect button, connect sheet, account menu
components/contract/    cards, generated param fields, review modal
pages/                  dashboard (/), contracts, contract detail (:id), activity
```

## Transparency rules

- Read functions run as `eth_call`: free, signature-free, no wallet.
- Write functions always open a **Transaction Review** step first: contract,
  address, exact function signature, every parameter as encoded, attached value,
  wallet, network, gas estimate, raw calldata.
- Confirm buttons name the function (`Confirm transfer`) - never a bare
  "Confirm".
- Wrong network blocks writes and offers an explicit `Switch Network`.
- Rejections before a hash exists leave no trace; after a hash everything is
  tracked in Activity with explorer links.
- This application never asks for private keys or seed phrases and never signs
  automatically.

## Development

```sh
npm install
npm run dev             # vite on :4001
```

## Gates

```sh
npm run lint:rtl        # no physical direction utilities (logical only)
npm run check           # types + lint over .ts and .azeroth
npm run build           # client + SSR bundle + prerender of /
npm test                # vitest suite
npm run verify          # all of the above, in CI order
```
