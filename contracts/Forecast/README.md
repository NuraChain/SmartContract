# Forecast — On-Chain Prediction Markets

Forecast is a prediction-market system ("forecasting markets"): an admin creates a market
around any future event ("Will X happen?", "Who wins Y?"), users trade shares of each possible
outcome against an automated market maker, and once the real-world result is known, an admin
declares the winning outcome and holders of that outcome's shares redeem them 1:1 for the
chain's native token.

Collateral is the chain's **native token** (no ERC-20 approval needed). Every outcome is an
**ERC-1155 token id**, and one unit of collateral always backs one *complete set* (one share
of every outcome) — which is what guarantees winning shares always redeem at full value.

> Vendored from the standalone AuctionHouse prediction-market project. Compiled here under
> solc `0.8.24`, `viaIR`, optimizer 400 runs, EVM target `cancun` (pinned per-file in the
> root `hardhat.config.ts`). Tests, deploy scripts, and typechain types live in the original
> project and are not part of this workspace copy.

---

## 1. Contract map

| File | Role |
| --- | --- |
| `PredictionFactory.sol` | Deploys markets as cheap EIP-1167 clones, holds `ADMIN_ROLE`, keeps the canonical registry with pagination and status filters. Every market trusts the factory as its *controller*. |
| `PredictionMarket.sol` | One market: CPMM trading, liquidity, resolution, redemption. An upgradeable-style ERC-1155 that is initialized exactly once per clone. |
| `PredictionTreasury.sol` | Sink for protocol fees. Markets forward their cut here; the owner withdraws to a configurable recipient. Two-step ownership (`Ownable2Step`) + reentrancy guard. |
| `PredictionTypes.sol` | Shared `MarketStatus` enum, `MarketParams` / `MarketRecord` structs. |
| `PredictionErrors.sol` | File-level custom errors shared across the system (cheaper and more decodable than revert strings). |
| `PredictionEvents.sol` | File-level events; one declaration site keeps emitted topics identical everywhere. |
| `libraries/MarketMath.sol` | Fixed-product buy/sell/price math over the reserve array. Only uses `Math.mulDiv` — no log/exp, no fixed-point library. |
| `libraries/FeeMath.sol` | Basis-point fee helpers: fee on a buy, gross-from-net on a sell, protocol/LP split. |
| `mocks/ReentrantBuyer.sol` | Reentrancy attacker mock used by the original project's test suite. |

Deployment cost is amortized: only the factory and treasury are "real" deployments; each new
market is a ~45-byte proxy clone pointing at a single shared implementation.

---

## 2. How a market works, end to end

1. **Create** — an admin calls `PredictionFactory.createMarket(params)` with attached native
   value as *seed liquidity*. The factory clones the implementation, initializes it, and
   registers it. The creator is credited as first LP.
2. **Trade** — until `lockTime`, anyone can `buy()` shares of an outcome or `sell()` them
   back. Prices move continuously with demand (AMM, no order book).
3. **Lock** — at `lockTime` trading stops automatically (checked on-chain, not by cron).
4. **Resolve** — an admin calls `resolve(winner)` with the real-world result, or
   `voidMarket()` if the outcome is invalid/ambiguous (everyone gets their money back
   equally).
5. **Redeem** — winners call `redeem()`: their winning shares are **burned** and they receive
   1 native token unit per share. Losing shares become worthless by construction.

### Lifecycle states (`MarketStatus`)

```
            pause()          unpause()
Open ─────────────────────▶ Paused ─────────────────────▶ Open
 │ ▲                                                  
 │ close()                (pause/unpause reversible)   
 ▼                                                     
Closed ──┐                                             
         │ resolve(winner)          voidMarket()       
         ├──────────────▶ Resolved   └──────────▶ Voided
         │                                │           │
         └────────────────────────────────┴───────────┘
                    terminal (no further trades)
```

- `Resolved` — only the winning outcome is redeemable (1:1).
- `Voided` — every outcome redeems for an equal `1/n` refund share of its balance.
- `close()` permanently halts trading ahead of resolution (e.g. the event got cancelled early,
  or trading must stop before `lockTime`).

---

## 3. Outcome shares and complete sets

Each market issues ERC-1155 tokens:

- **Ids `0 .. n-1`** — one id per outcome (n = `outcomeCount`, between 2 and `MAX_OUTCOMES = 16`).
  Holding `x` shares of outcome `i` entitles you to `x` collateral if `i` wins.
- **Id `type(uint256).max`** (`LP_TOKEN_ID`) — liquidity-provider shares.

The key accounting object is the **complete set**: 1 share of *every* outcome. Because one
complete set is guaranteed to pay out exactly 1 unit no matter who wins, the system maintains
one invariant (see §7):

```
reserve[i] + totalUserSupply(i) == totalSets == contract native balance
```

You can convert collateral ⇄ complete sets directly with `mergeSets(amount)` — burn one share
of each outcome, receive `amount` native back. This is also how arbitrage keeps AMM prices
tethered to reality (if all prices summed to less than 1, merging would be free money).

---

## 4. Pricing and trading (the CPMM)

The market is a **fixed-product market maker** over an array of virtual reserves `_reserves[]`,
one per outcome, with the invariant `∏ reserve[j] = k`. Reserves are tracked virtually — the
market never custodies outcome tokens, it is their sole issuer/minter.

**Price of outcome `i`:**

```
p_i = (1/r_i) / Σ_k (1/r_k)          (in 1e18 fixed point; Σ p_i ≈ 1e18)
```

Computed via reciprocals so no product of reserves is ever formed — overflow-safe for all 16
outcomes. A fresh n-way market opens at exactly `1/n` per outcome.

**Buying** `outcomeIndex` with gross collateral `amountIn`:

1. Fee is taken off the top: `invest = amountIn − fee`.
2. `invest` is added to *every* reserve, then the bought outcome's reserve is reduced by the
   shares minted:
   ```
   endReserve_i = r_i · ∏_{j≠i} ( r_j / (r_j + invest) )
   sharesOut    = r_i + invest − endReserve
   ```
3. Buyer gets `sharesOut` minted to them; slippage bound `minSharesOut` and a `deadline`
   timestamp protect against sandwich attacks and stale quotes.

*Worked example* — fresh binary market (Yes/No), seeded with 100 units per side (prices 50/50).
Buy Yes with 10 collateral at 0% fee:
`endReserve_yes = 100 · 100/110 ≈ 90.91` → `sharesOut = 100 + 10 − 90.91 ≈ 19.09` shares.
New price of Yes ≈ `(1/90.91) / ((1/90.91)+(1/110)) ≈ 0.547` — your buy pushed Yes from 50% to ~54.7%.

**Selling** is the exact inverse: you specify the *net collateral* you want out
(`returnAmount`), the pool computes the gross removal (ceil-rounded, pool-favourable) and the
shares it will burn from you, bounded by `maxSharesIn`.

Previews exist off-chain-friendly: `calcBuy(index, amountIn)` and `calcSell(index, net)` plus
`getPrices()` / `getReserves()` views.

---

## 5. Fees

Two parameters per market, set at creation, both hard-capped:

- `feeBps` — total trade fee, max `MAX_FEE_BPS = 1000` (10%), taken on every buy and sell.
- `protocolFeeShareBps` — how much of each fee goes to the treasury (max 100%);
  **the remainder stays with liquidity providers**.

On a sell, the fee is computed by grossing up: `gross = net · BPS / (BPS − feeBps)` (rounded
up), so the fee is never understated.

Where the two cuts go:

- **Protocol cut** → forwarded immediately to the `PredictionTreasury` via `depositFee{value}`.
- **LP cut** → re-injected into the reserves as fresh liquidity. This lifts the value of every
  LP share without needing a per-share fee accumulator — LPs earn implicitly because their
  proportional claim of the reserves grows.

A market created with `feeBps = 0` / `protocolFeeShareBps = 0` inherits the factory defaults
(`defaultFeeBps`, `defaultProtocolFeeShareBps`); explicit values pass through unchanged.

---

## 6. Liquidity provision

**Adding** (`addFunding(minLpSharesOut)` — payable, only while `Open` and before `lockTime`):

- First LP after a zero-supply edge: mints LP shares 1:1 with the amount.
- Otherwise, contribution is measured against the **largest reserve**:
  `lpShares = amount · lpSupply / maxR`. Per outcome, the fraction of your deposit that the
  pool actually needs is kept (`keep = amount · r_j / maxR`), and the excess is handed back
  **as outcome tokens** — i.e. you buy into the pool's current skew rather than moving prices.
  This makes LP-ing dilution-fair regardless of how skewed prices are.

**Removing** (`removeFunding(lpShares)`) — burns LP shares and returns a **proportional basket
of outcome shares** (`r_j · lpShares / lpSupply` per outcome). You receive the basket, not raw
collateral; convert it via trading, `mergeSets`, or (after resolution) `redeem`.

---

## 7. Resolution, redemption, and the solvency invariant

While trading, after every operation:

```
for every outcome i:   reserve[i] + totalUserSupply(i)  ==  totalSets  ==  address(this).balance
```

Why it holds: buys/sells/funding move identical amounts into/out of *every* outcome's total,
fees either stay in the pool (LP cut) or leave through the treasury (protocol cut) which
`totalSets` excludes, and `totalSets` always equals the contract's native balance. Consequence:
**winning shares can always redeem 1:1 — the pool cannot go insolvent.**

**Redemption** (`redeem()`, pull-payment — the market never pushes funds to anyone):

- `Resolved`: burns *all* of your winning-outcome shares, pays `balance × 1` native.
- `Voided`: burns your balances of every outcome, pays `sum ÷ n` (equal-refund basis).
- Shares are **burned before payment**, so double-claiming is impossible by construction,
  not by a flag. Payout is additionally capped at `totalSets` as a belt-and-braces guard.

---

## 8. Who can do what

| Action | Anyone | Factory admin (`ADMIN_ROLE`) | Notes |
| --- | --- | --- | --- |
| `buy` / `sell` / `calcBuy` / `calcSell` | ✅ | — | Only while `Open` and `block.timestamp < lockTime` |
| `addFunding` / `removeFunding` / `mergeSets` | ✅ | — | Funding requires `Open`; `mergeSets` blocked after Resolved/Voided |
| `redeem` | ✅ | — | Requires `Resolved` or `Voided` |
| `createMarket` (payable) | — | ✅ | Clones + initializes + registers atomically |
| `pause` / `unpause` / `close` / `resolve` / `voidMarket` | — | ✅ | Called through the factory, which relays to the clone and syncs its registry |
| `setDefaultFees`, `setTreasury`, `repointTreasury` | — | ✅ | `repointTreasury` is per-market so gas stays bounded |
| Treasury `withdraw`, `setFeeRecipient` | — | Treasury owner | Two-step ownership handover |

The implementation contract's constructor calls `_disableInitializers()`: only clones can be
initialized, never the implementation itself.

---

## 9. Security mechanisms

- **Reentrancy**: storage-based lock (`_entered`, compatible with pre-transient-storage EVM
  targets) on every value-moving function; treasury withdrawals guarded too. Verified by the
  original suite using the `ReentrantBuyer` mock.
- **Checks-effects-interactions**: all state and accounting updates complete before any
  external call (treasury forwarding, native sends).
- **Pull payments**: `redeem()` and treasury withdrawal are claim-based; nothing pushes value.
- **Sandwich/stale-quote protection**: `minSharesOut` / `maxSharesIn` slippage bounds +
  `deadline` on every trade; `minLpSharesOut` on funding.
- **Rounding always favours the pool**: buys floor, sells ceil (`Math.Rounding.Ceil` on the
  sell path and fee gross-up) — the maker can never be drained by rounding dust.
- **Checked native transfers**: explicit success check on every `call{value}`, custom
  `TransferFailed` error; no `transfer()`/`send()` gas-stipend assumptions.
- **Bounded loops**: `MAX_OUTCOMES = 16` caps every per-outcome loop's gas.
- **Registry integrity**: the factory relays lifecycle actions so its per-market status cache
  stays authoritative without cross-calling clones during listings.
- **Access control**: OpenZeppelin `AccessControl` on the factory; `Ownable2Step` on the
  treasury (no fat-fingered owner handover).

---

## 10. Constants and limits

| Constant | Value | Meaning |
| --- | --- | --- |
| `MAX_OUTCOMES` | 16 | Maximum outcomes per market |
| `MAX_FEE_BPS` | 1000 | Maximum total trade fee (10%) |
| `LP_TOKEN_ID` | `type(uint256).max` | ERC-1155 id reserved for LP shares |
| `BPS` | 1e4 | Basis-point denominator |
| Timing rule | `now < lockTime ≤ resolveTime` | Enforced at creation (`InvalidTiming`) |

---

## 11. Trust assumptions and design trade-offs

Read these before relying on the system:

- **Resolution is centralized.** A single admin key decides the winning outcome and can
  `resolve` at any time — including *before* `lockTime`; the contract does not enforce that
  the event deadline has passed. Integrity of payouts rests entirely on the honesty of the
  `ADMIN_ROLE` holder(s). There is no dispute window or oracle integration.
- **Admin can pause/close at will**, stranding traders in `Closed` until an eventual
  resolve/void. Funds are never stealable — every path ends in pro-rata or winner-take-all
  payout — but trading can be halted indefinitely.
- **Void refunds round down** (`sum / n` floors), leaving negligible dust in the contract.
- **After resolution, losing shares are deliberately dead**; only the winning side needs to
  stay backed (the invariant relaxes accordingly).
- **Metadata is plain strings** (`title`, `description`, `category`, `imageURI`) stored
  on-chain; nothing pins or verifies them.
- Binary questions are modeled as **two on-chain outcomes** (e.g. index 0 = "Yes",
  index 1 = "No"); frontends typically synthesize the NO leg as `1 − price(YES)`.

---

## 12. Source files

```
contracts/Forecast/
├── PredictionFactory.sol        # Clone factory + ADMIN_ROLE registry control plane
├── PredictionMarket.sol         # One market: ERC-1155 shares, CPMM trading, settlement
├── PredictionTreasury.sol       # Protocol-fee sink (Ownable2Step)
├── PredictionTypes.sol          # MarketStatus enum, MarketParams/MarketRecord structs
├── PredictionErrors.sol         # Shared custom errors
├── PredictionEvents.sol         # Shared events
├── interfaces/
│   ├── IPredictionFactory.sol
│   ├── IPredictionMarket.sol
│   └── IPredictionTreasury.sol
├── libraries/
│   ├── MarketMath.sol           # FPMM trade/pricing math (mulDiv only)
│   └── FeeMath.sol              # bps fee split: protocol vs LP retention
└── mocks/
    └── ReentrantBuyer.sol       # Test-suite reentrancy attacker
```
