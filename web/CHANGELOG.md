# Changelog

Notable changes to Contract Manager. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

The contracts this application administers live in a separate repository; this
changelog covers the Contract Manager application itself.

## [2.0.0] - 2026-08-24

### Changed

**The exchange is now the Contract Manager.** The application is a transparent
administrative panel for the deployed Nura Chain contracts instead of a trading
frontend: a registry-driven contract list, a per-contract workbench that renders
read and write forms straight from each ABI, a mandatory transaction-review step
before any wallet prompt, and a local activity log for everything executed here.

- `src/config/contracts.ts` is the single source of truth for supported
  contracts; ABIs are compiled artifacts extracted by `npm run extract:abi`.
  Entries without a recorded deployment say so - addresses are never guessed.
- Reads run as static calls (no wallet, no gas), which also makes QuoterV2-style
  revert-to-answer functions work as reads via per-contract `staticCallables`.
- Writes go through one path (`lib/tx-manager.ts`): guards → gas estimate with
  decoded reverts → review modal naming contract, address, signature, encoded
  parameters, value, wallet, network and raw calldata → explicit
  `Confirm <function>` → sign → receipt → activity log.
- Errors classify once in `lib/errors.ts`: plain-object EIP-1193 rejections,
  pending wallet requests, chain mismatch, insufficient funds,
  `Error(string)`/`Panic(uint256)` revert data, RPC failures - human title plus
  expandable technical detail.

### Removed

- The indexer/server half, the market API, and the SQLite data layer: reads now
  go directly to the chain over the configured RPC.
- The swap, liquidity and portfolio pages and all of their domain components;
  the ten-language i18n layer (the app ships English; logical-direction
  utilities remain enforced by `npm run lint:rtl`); the AMM maths workspace.

## [1.1.1] - 2026-08-21

### Changed

`scripts/service-install.sh` installs the unit as `nura-swap` and gives systemd
5 seconds between restarts rather than 3. `deploy/` is gone with it: the
generator writes the unit for wherever the repo actually sits, which left the
fixed-path `/srv/nuraswap` copy with nothing to offer, and the Caddy snippet it
carried is already in the README.

### Fixed

**`npm ci` builds off Windows.** Tailwind's oxide compiler ships as a
platform-specific optional dependency, so a lockfile resolved on Windows carried
only the msvc binary and a Linux box installed no compiler at all. Both the
`linux-x64-gnu` and `win32-x64-msvc` builds are pinned in `optionalDependencies`,
so one lockfile resolves on either.

**The unit generator no longer runs its own comment.** The heredoc that writes
the service file is unquoted so that the resolved node and server paths expand -
which also made a backtick in the surrounding comment a command substitution,
executed while the unit was being written.

**A repo under `/home` starts.** `ProtectHome=true` hides `/home` and `/root`
from the service, and takes `WorkingDirectory` with it: systemd failed the unit
with 200/CHDIR before it ran a line. The installer follows the repo wherever it
sits, so the directive is now emitted only where it cannot bite.

## [1.1.0] - 2026-08-21

### Added

**V3 trades are charted.** A concentrated pool has no reserves to price an
hourly candle from, but every V3 `Swap` reports the pool's own post-trade
`sqrtPriceX96` - so the series is drawn from that instead, in the same
orientation and scale a V2 pair is priced in. The pool detail route serves a V3
pool alongside a V2 pair, with the pool's balances where a pair carries reserves.

**The NURA price in the header.** On every page rather than only the market ones,
read off the WNURA pool, at price precision rather than money precision - a
sub-cent native token printed as $0.00 under the two-decimal rule.

### Changed

The swap chart follows the selected exchange's own pool, and falls back to the
other only when its own has no trades to draw - saying so, since the two pools
price independently.

### Fixed

Switching account in the wallet rebinds the signing client. The account signal
followed the switch while `walletClient` kept the account baked in at connect, so
the header showed the new account while every swap, approve and deposit was
signed as the old one.

## [1.0.0] - 2026-08-20

First release. Everything below is what the exchange ships with.

### Added

**Swap.** Router-quoted trades with live price impact, slippage and deadline
control, and an approve-then-swap flow. NURA wraps and unwraps directly against
WNURA. A price chart and the recent-trades feed sit beside the card. Routes and
prices re-quote every 30 seconds on a visible tab, and a trade above 15% impact
demands explicit confirmation before it can be signed.

**UniswapV3 alongside V2.** A `V2 | V3` switch on the swap and liquidity pages,
shown only where the chain's deployment carries a V3 factory. V3 swaps quote
every enabled fee tier through the Quoter, trade the best by default, and let a
trader pin a tier. V3 liquidity covers the whole position lifecycle: mint with a
price range (or full range), create-and-initialize a pool at a chosen opening
price, add, withdraw, and collect fees. Pool discovery, positions and fee
accounting are read straight from the chain over multicall.

**Liquidity.** Pools table with TVL, 24h volume and fee APR; your positions;
add with ratio auto-fill and a first-provider price warning; remove with a
percent slider. Every flow shows a summary before the wallet prompt.

**Portfolio.** Holdings with USD values, LP positions, and your own on-chain
activity, with wrap and unwrap available from the row.

**Wallets.** Every EIP-6963 injected wallet is admitted by its own rdns, with
silent session restore, address identicons, and a one-prompt "add Nura Chain to
wallet".

**Ten languages, two of them right-to-left.** Persian and Arabic get mirrored
layouts, their own numerals and percent sign in display, and Vazirmatn falling
through per glyph in all three type roles. Amounts, addresses and hashes stay
left-to-right islands in every direction. Input in Persian or Arabic-Indic
digits normalizes back to ASCII before any amount is parsed. A grep lint
(`npm run lint:rtl`) rejects physical direction utilities in CI.

**Light and dark themes** following the system by default, pinned by an explicit
choice, applied before first paint.

**Indexer and market API.** A polling chain watcher over `PairCreated`, `Sync`,
`Swap`, `Mint` and `Burn` into SQLite, serving `/api/market/*` — stats, pools,
pool detail with hourly candles, the token registry with USD prices,
transactions, and the active deployment. Restart-safe: a chain-identity guard
re-indexes a re-genesised chain, a cursor past the head triggers a wipe, and a
cursor-hash mismatch rewinds and rescans with idempotent inserts.

**Shared maths.** Bigint end to end — the V2 quote, impact and decimal scaling,
the V3 Q64.96 tick and liquidity library ported from the audited Solidity with
matching rounding, digit normalization, and the typed deployment artifacts.

**Tests.** 563 across three vitest suites: the AMM and tick maths with seeded
property and fuzz laws, the indexer driven end to end against a scripted EVM,
the market API and its production HTTP edge, and the application's libraries,
components and page journeys at every viewport in both directions. Coverage is
wired per workspace (`npm run coverage`), and CI runs the gates as named stages.

**Documentation.** `TESTING.md` maps every spec file to what it defends;
`CLAUDE.md` records the frontend architecture, design system, RTL and
accessibility rules, and the visual QA loop.

### Changed

- The exchange runs on **Nura Chain** (id 1020) at zero confirmations — CometBFT
  finality means a committed block is final, so there is no cushion to wait out.
- The swap fee is **read from the factory**, never assumed. The factory holds it
  in basis points and `feeToSetter` can retune it, so the server reads it at
  boot, serves it on `/api/market/stats`, and the swap card prints what the
  chain says.
- Token symbols, names and decimals are read from the **contracts**, not from
  the deployment artifact — a stale or hand-edited artifact can no longer make
  the app call a token something it does not call itself.
- The exchange contracts were extracted into their own repository; this one
  consumes their deployment artifact and imports no Solidity.
- The brand is "Nura Swap", two words.
- The language picker opens as a centred modal flying real 4:3 flags.
- The Docker image was dropped in favour of the systemd and Caddy runbook.

### Fixed

- WNURA and NURA are recognised as a wrap pair again — the two sides of that
  comparison arrive with different casing, so a literal match reported "no pool"
  and offered to approve the router for what is really a withdraw.
- A failed deployment load no longer sticks: the in-flight request is shared, but
  a **rejected** one is not memoized, so one bad first load no longer poisons
  every later call for the life of the tab.
- The wallet prompt goes out before anything is awaited, so a wallet that has
  lost the click's user activation no longer queues its approval window behind
  its toolbar icon.
- A down API half no longer takes the landing page with it, and no page mount
  leaks an unhandled rejection during an outage.
- The dev proxy follows `server/.env`, so setting `PORT` there no longer 404s
  every `/api` call in development.
- `nearestUsableTick` clamped to `MIN_TICK`/`MAX_TICK`, which no tick spacing
  divides — full range, the first thing any position UI reaches for, produced
  bounds the pool rejects. It now clamps to the outermost on-grid tick.
- A token whose `bytes32` metadata is a zero word reached the served registry
  with an empty symbol; it now keeps the unknown placeholder, as the browser's
  importer always has.
- A token repeated in the V3 sweep list produced the same pool twice in the
  table.
- ARIA state attributes were bound to booleans and rendered as `aria-pressed=""`,
  which tells a screen reader neither that a control is a toggle nor its state.
  They are now enumerated strings across every toggle.
- The localized "Unpriced" placeholder inherited the monospace column face, so
  in Persian its letters came from Vazirmatn while the space kept IBM Plex
  Mono's advance — a visible gap mid-phrase. The mono face now applies to the
  number, not the word.

### Security

- **The Content-Security-Policy is now actually sent.** It was applied by
  mutating `response.headers`, which the kernel's payload response discards, so
  every production response left without the one header the whole module exists
  for. Injected script on a DEX front-end does not deface a page, it rewrites
  the address an approval is signed for.
- **The rate limiter buckets per client behind a proxy.** With the forwarded
  address distrusted and Caddy terminating TLS, every visitor shared one
  2000/min budget that any single client could exhaust for everyone. Set
  `TRUST_PROXY=true` wherever something sits in front; it stays off by default
  so a directly exposed server never believes a client-forgeable header.
- The deployment loader refuses a chain id that is not a plain non-negative
  integer — it becomes part of a filesystem path, and `../package` resolved out
  of the deployments folder.
- The CSP allows no inline or eval script; the one inline pre-paint theme script
  is permitted by hash, and a test recomputes that hash from the built HTML so
  the script cannot drift out of policy silently.
- A coin brand is earned by **address** from the served deployment, never by the
  symbol a token declares about itself — anyone can deploy an ERC20 calling
  itself mUSDT.

## Development history

No versions were tagged before 1.0.0. The work landed as:

- **2026-08-07** — repository scaffolding, CI and the deploy runbook; the shared
  bigint AMM maths and deployment artifacts; the chain indexer and market API
  over SQLite; the vendored UniswapV2 exchange and tooling; the web app.
- **2026-08-17** — the exchange contracts moved into their own repository.
- **2026-08-18** — the move to Nura Chain (id 1020) at zero confirmations; ten
  languages behind a picker with self-hosted flag sprites; add-chain-to-wallet;
  the wallet-activation and deployment-load fixes; token names read from the
  contracts; the bridged BNB and USDT registry entries; the 30-second re-quote.
- **2026-08-19** — the swap fee read from the factory; wrap and unwrap from the
  portfolio row; the WNURA wrap-pair and dev-proxy fixes; real flags in the
  picker.
- **2026-08-20** — UniswapV3 beside V2; the test suite, coverage and CI stages;
  the CSP, rate-limiting and path-shape fixes; the frontend workflow docs.

[1.0.0]: https://github.com/NuraChain/Swap/releases/tag/v1.0.0
