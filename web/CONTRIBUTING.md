# Contributing

## Setup

Node >= 22. `npm install` at the root wires the single `application` workspace.
This repo targets ONE chain - Nura Chain (id 1020) - and talks to it directly
over its public RPC; nothing needs deploying or indexing to run the app. The
contracts live in their own repository: check it out only when you need to
deploy new contracts or regenerate ABIs (`npm run extract:abi` reads that
repo's Hardhat artifacts). There is no in-app signer - wallet flows are
exercised with a real wallet extension against Nura Chain, so an address with a
little NURA for gas is the price of testing them.

## Before you open a PR

Run the same gates CI runs:

```sh
npm run lint:rtl                  # no physical direction utilities
npm run check                     # types + lint over .ts and .azeroth
npm run build                     # client, SSR bundle, prerender of /
npm test                          # vitest suite
```

## Ground rules

- `application/src/config/contracts.ts` is the ONLY place contracts are
  defined. ABIs under `src/config/abi/` are generated from the contracts
  repository's build output by `scripts/extract-abi.mjs` (bytecode dropped) -
  never edit them by hand, and never paste an address you cannot cite to that
  repository's deployment records.
- An entry with `address: null` renders as "no deployment recorded". Do not
  invent addresses to make a card look complete.
- Writes have ONE path: `lib/tx-manager.ts`. Never sign from a component, never
  skip the review step, and never label a confirm button anything but the
  function being sent.
- Reads never need a wallet. If a "read" asks for one, it belongs in the write
  section or in `staticCallables`.
- Use logical direction utilities (`ms/me`, `ps/pe`, `start/end`);
  `npm run lint:rtl` rejects physical ones. Addresses, hashes and raw numbers
  stay LTR islands via `data-ltr`.
- No new UI framework, no CSS-in-JS, no hex colours in components - tokens live
  in `styles.css`.
