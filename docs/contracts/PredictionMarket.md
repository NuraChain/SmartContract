# PredictionMarket

## Contract Overview

| Property | Value |
| --- | --- |
| Contract name | `PredictionMarket` |
| Solidity file | `contracts/forecast/PredictionMarket.sol` |
| Solidity version | `0.8.24` exact (compiled viaIR, cancun) |
| Contract type | Concrete CPMM prediction market; deployed as an **EIP-1167 clone** by [`PredictionFactory`](PredictionFactory.md), initialized exactly once |
| Purpose | Fixed-product market-maker over 2..16 outcomes; collateral is the chain's native coin; each outcome is an ERC-1155 id `0..n-1`; liquidity providers hold LP token id `type(uint256).max` |
| Upgradeable | Uses OpenZeppelin *Initializable* pattern only (clone-initialization, not proxy upgrades) |

**Core invariant** (maintained by every state transition, asserted in tests):

```text
for every outcome i:  reserves[i] + totalUserSupply(i) == totalSets == contract balance
```

A buy/sell/funding operation adds or removes the same amount from every outcome's total,
so cross-outcome equality is preserved and winning shares always redeem 1:1 without
insolvency. Reserves are tracked virtually; the market never custodies outcome tokens it
did not mint.

## Inheritance

```text
PredictionMarket
├── IPredictionMarket   -- implemented interface
├── Initializable       -- `initializer` guard for clones
└── ERC1155SupplyUpgradeable
    └── ERC1155Upgradeable  -- multi-token core + per-id supply tracking
```

## Interfaces

| Interface | Interaction |
| --- | --- |
| `IPredictionMarket` | Implemented surface (`initialize`, trading, liquidity, lifecycle, views). |
| `IPredictionTreasury` | `depositFee{value}(address(this))` forwards the protocol cut after buys/sells. |

## State Variables

| Variable | Type | Visibility | Mutability | Purpose |
| --- | --- | --- | --- | --- |
| `LP_TOKEN_ID` | `uint256` | public | constant | `type(uint256).max`; ERC-1155 id of LP shares (outcomes use ids 0..n-1). |
| `MAX_OUTCOMES` | `uint256` | public | constant | `16`; bounds every per-outcome loop (gas ceiling). |
| `MAX_FEE_BPS` | `uint16` | public | constant | `1000`; max total trade fee (10%). |
| `controller` | `address` | public | mutable | The factory; sole caller of lifecycle actions. |
| `treasury` | `address` | public | mutable | Receives protocol fees. |
| `status` | `MarketStatus` | public | mutable | Lifecycle state (Open/Paused/Closed/Resolved/Voided). |
| `title/description/category/imageURI` | `string` | public | immutable-in-practice | Metadata written once in `initialize`. |
| `creator` | `address` | public | set-once | Account credited as creator/first LP. |
| `createdAt/lockTime/resolveTime` | `uint64` | public | set-once | Timestamps; trading requires `block.timestamp < lockTime`. |
| `feeBps` | `uint16` | public | set-once | Total trade fee (bps). |
| `protocolFeeShareBps` | `uint16` | public | set-once | Treasury share of each fee; remainder accrues to LPs via re-injection. |
| `outcomeCount` | `uint256` | public | set-once | Number of outcomes n. |
| `_outcomeNames` | `string[]` | private | set-once | Display names per index. |
| `_reserves` | `uint256[]` | private | mutable | Virtual FPMM reserve per outcome (wei). |
| `totalSets` | `uint256` | public | mutable | Collateral backing outstanding complete sets; equals contract native balance. |
| `_winningOutcome` | `uint256` | private | set at resolve | Meaningful only when Resolved. |
| `_entered` | `uint256` | private | mutable | Reentrancy lock: 1 = free, 2 = entered (storage-based; Paris target has no transient storage); set to 1 in `initialize`. |

ERC-1155 balances: outcome shares per user, plus LP shares under `LP_TOKEN_ID`
(`totalSupply(LP_TOKEN_ID)` is the LP share supply).

## Structs / Enums

Uses shared types from `PredictionTypes.sol`: struct `MarketParams` (see
[PredictionFactory](PredictionFactory.md)), enum `MarketStatus`.

## Constants

See table above. Economic significance: `MAX_FEE_BPS` caps extractable fee even if a
compromised factory tries to initialize a market with a huge fee.

## Modifiers

| Modifier | Condition | Prevents | Used by |
| --- | --- | --- | --- |
| `onlyController` | `msg.sender == controller` | anyone but the factory driving lifecycle | `pause`, `unpause`, `close`, `resolve`, `voidMarket`, `setTreasury` |
| `nonReentrant` | `_entered != 2` | reentrancy into value paths | `buy`, `sell`, `addFunding`, `removeFunding`, `mergeSets`, `redeem` |

## Events

Shared declarations live in `PredictionEvents.sol`:

| Event | Parameters | Indexed | Trigger |
| --- | --- | --- | --- |
| `LiquidityAdded` | `market, funder, amount, lpShares` | market, funder | `initialize` (seed) and `addFunding` |
| `LiquidityRemoved` | `market, provider, lpShares` | market, provider | `removeFunding` |
| `PredictionPlaced` | `market, buyer, outcome, amountIn, sharesOut` | first three | `buy` |
| `PredictionSold` | `market, seller, outcome, sharesIn, amountOut` | first three | `sell` |
| `RewardClaimed` | `market, claimant, amount` | market, claimant | `redeem` and `mergeSets` |
| `MarketPaused/MarketUnpaused/MarketClosed/MarketVoided` | `market` | market | lifecycle relays |
| `MarketResolved` | `market, winningOutcome` | both | `resolve` |

## Errors

| Error | Trigger condition | Paths |
| --- | --- | --- |
| `ZeroAddress()` | init with zero controller/treasury/creator | `initialize` |
| `ZeroAmount()` | zero value/amount on money paths | `initialize`, `buy`, `addFunding`, `mergeSets`, `removeFunding(0)` |
| `InvalidOutcomeCount()` | outcomes not in [2,16] | `initialize` |
| `InvalidOutcome()` | `outcomeIndex >= outcomeCount` | guarded paths |
| `InvalidFee()` | feeBps > MAX or share > BPS | `initialize` |
| `InvalidTiming()` | !(now < lockTime ≤ resolveTime) | `initialize` |
| `MarketNotOpen()` | status ≠ Open where required | trading, addFunding, pause/unpause |
| `TradingLocked()` | `block.timestamp >= lockTime` | trading, addFunding |
| `MarketNotResolved()` | redeem/claim before terminal | `redeem` |
| `MarketAlreadyEnded()` | lifecycle action after terminal | close/resolve/void/mergeSets |
| `DeadlineExpired()` | `block.timestamp > deadline` | `buy`, `sell` |
| `SlippageExceeded()` | output worse than bound | `buy`, `sell`, `addFunding` |
| `InsufficientLiquidity()` *(via MarketMath)* | other reserve cannot cover sell withdrawal | `sell` |
| `NothingToClaim()` | nothing to redeem/burn | `redeem` |
| `NotController()` / `Reentrancy()` / `TransferFailed()` | guard violations / failed send | respective |

## Functions

### Classification

- **User / Financial:** `buy`, `sell`, `addFunding`, `removeFunding`, `mergeSets`, `redeem`
- **Administrative (factory-only):** `pause`, `unpause`, `close`, `resolve`,
  `voidMarket`, `setTreasury`, `initialize` (factory calls once)
- **View:** `winningOutcome`, `getReserves`, `getPrices`, `calcBuy`, `calcSell`,
  `outcomeName`, `totalSets` (+ ERC-1155 getters)
- **Private:** `_requireTradable`, `_requireNotEnded`, `_sendNative`

---

### initialize

```solidity
function initialize(address controller_, address treasury_, MarketParams calldata params)
    external payable initializer;
```

**Purpose:** One-time clone setup; converts the bare clone into a live market seeded with
`msg.value` LP liquidity.

**Access:** intended to be called exactly once by [`PredictionFactory`](PredictionFactory.md)
inside `createMarket` (same tx as cloning ⇒ no front-run window). The standalone
implementation's constructor calls `_disableInitializers()`, so it can never be
initialized directly.

**Flow:** validate addresses / outcome count 2..16 / fees / `now < lockTime ≤ resolveTime`
/ value > 0 → init ERC-1155 + `_entered = 1` → copy metadata → push n reserves = seed →
`totalSets = seed` → `_mint(params.creator, LP_TOKEN_ID, seed)` → emit `LiquidityAdded`.

**State changes:** everything above. **Events:** `LiquidityAdded`.
**Errors:** see table (`ZeroAmount` when no seed).

---

### buy

```solidity
function buy(uint256 outcomeIndex, uint256 minSharesOut, uint256 deadline)
    external payable nonReentrant returns (uint256 sharesOut);
```

**Purpose:** Spend attached native collateral on outcome shares at FPMM price.

| Parameter | Type | Description |
| --- | --- | --- |
| `outcomeIndex` | `uint256` | Outcome to buy (must exist) |
| `minSharesOut` | `uint256` | Slippage bound: revert if fewer shares would be received |
| `deadline` | `uint256` | Tx validity timestamp |

**Access:** anyone while Open and pre-lockTime.

**Flow:** deadline check → `_requireTradable` → fee split via `FeeMath`
(`fee`, protocol `cut`, `lpFee`, `invest = amountIn - fee`) →
`sharesOut = MarketMath.calcBuyShares(_reserves, i, invest)` → slippage check →
effects: every reserve += `invest+lpFee`; bought reserve -= sharesOut;
`totalSets += invest+lpFee`; mint shares → interaction: forward `cut` to treasury.

**Events:** `PredictionPlaced`. **Errors:** listed above.
**Security:** MEV-protected by `minSharesOut`+`deadline`; reentrancy-guarded; CEI respected
(treasury call last). Fees charged on the amount actually sent in.

---

### sell

```solidity
function sell(uint256 outcomeIndex, uint256 returnAmount, uint256 maxSharesIn, uint256 deadline)
    external nonReentrant returns (uint256 sharesIn);
```

Inverse: burn `sharesIn` outcome tokens, receive `returnAmount` collateral net of fee.
`grossFromNet` rounds the fee up (`FeeMath.grossFromNet`). Effects: burn; every other
reserve -= gross; bought-outcome reserve += sharesIn − gross; `totalSets -= gross`;
LP fee re-injected into all reserves (+ totalSets) so LPs keep their cut. Interactions:
protocol cut to treasury, then `_sendNative(seller)`.
Slippage bound is `maxSharesIn` (max tokens you give up).

---

### addFunding

```solidity
function addFunding(uint256 minLpSharesOut) external payable nonReentrant returns (uint256 lpShares);
```

Add liquidity while Open and pre-lock.

- If LP supply == 0: all value becomes reserves; `lpShares = amount`.
- Else: proportional to `maxReserve`; per outcome j, `keep = amount·r_j/maxR` stays in
  reserves and the remainder `sendBack` is minted to the depositor **as outcome-j tokens**
  (this keeps the invariant intact when reserves are skewed).

`totalSets += amount`; slippage bound `minLpSharesOut`; mints LP shares last.
No `deadline` parameter — a pending deposit can land after a price move (MEV note).

---

### removeFunding

```solidity
function removeFunding(uint256 lpShares) external nonReentrant;
```

Burn LP shares; receive pro-rata **outcome tokens** (`out_j = r_j · lpShares/lpSupply`,
minted per outcome), not collateral — complete-set conversion happens via `mergeSets`
or by holding winners through resolution. Allowed in any non-terminal status (even
post-resolution, letting LPs take winning tokens for redemption).
**No slippage/deadline parameters** — frontrunning risk documented (design consideration).

---

### mergeSets

```solidity
function mergeSets(uint256 amount) external nonReentrant;
```

Burn one of *each* outcome token × `amount`, receive exactly `amount` native back
(1:1, fee-free). Blocked only after terminal status. Emits `RewardClaimed`.

---

### redeem

```solidity
function redeem() external nonReentrant returns (uint256 payout);
```

Post-terminal redemption:

- **Resolved:** burns caller's entire winning-token balance, pays 1:1.
- **Voided:** burns caller's balances across all outcomes, pays `floor(Σ balances / n)`
  — treats holdings as fractional complete sets. Rounding dust favours the pool; payout
  clamped to `totalSets` (saturating, first-come-first-served under extreme cases).

Effects before the send; emits `RewardClaimed`; reverts `NothingToClaim` /
`MarketNotResolved`.

---

### Lifecycle (controller-only)

```solidity
pause()/unpause()        // reversible halt (Open↔Paused); MarketNotOpen otherwise
close()                  // permanent stop betting/trading, await resolution
resolve(uint256 w)       // declare winner; any time, even BEFORE lockTime (documented trust assumption)
voidMarket()             // refund mode; every outcome pays equal share
setTreasury(address)     // re-point fee sink; zero-checked
```

All guarded by `onlyController` (the factory relays admin actions) and
`_requireNotEnded` where applicable. `resolve` validates the outcome index and emits
`MarketResolved`.

---

### Views

```solidity
winningOutcome()                     // reverts MarketNotResolved unless Resolved
getReserves() -> uint256[]           // virtual reserves per outcome
getPrices()    -> uint256[]          // marginal prices, WAD, sum ≈ 1e18 (MarketMath.prices)
calcBuy(i, amountIn)  -> sharesOut   // static quote (net of fee)
calcSell(i, returnAmt) -> sharesIn   // static quote (gross-of-fee)
outcomeName(i) -> string             // display name; InvalidOutcome guard
totalSets()                          // == contract balance (invariant anchor)
```

Plus ERC-1155 surface: `balanceOf`, `balanceOfBatch`, `isApprovedForAll`,
`safeTransferFrom`, `safeBatchTransferFrom`, `setApprovalForAll`, `uri` (empty base),
`totalSupply(id)`, `supportsInterface`.

## Access Control

| Function | Required role | Who |
| --- | --- | --- |
| `buy/sell/addFunding/removeFunding/mergeSets/redeem` | none | Anyone (subject to status/lockTime) |
| lifecycle + setTreasury | factory controller (`ADMIN_ROLE` upstream) | Admin via factory |
| `initialize` | factory, once, same-tx-as-clone | Factory |

## Token / Financial Flow

```text
Buyer ──buy{value}──▶ market
         ├─ fee ─┬─ protocol cut ──▶ Treasury.depositFee
         │        └─ lpFee ── stays in reserves (LP value)
         └─ invest ──▶ reserves ⇄ shares minted to buyer
Seller ──sell(shares)──◀ native (net of fee) ; sets burned
Winner ──redeem──▶ 1:1 native from totalSets
```

## External Contract Interactions

| Target | Call | Failure behaviour |
| --- | --- | --- |
| `IPredictionTreasury(treasury)` | `depositFee{value}(market)` | revert bubbles (blocks buy/sell if treasury broken — trusted infra) |
| `payable(to).call{value}` (`_sendNative`) | payouts | `TransferFailed` on failure; recipients can make redeem/merge revert (their own funds only) |

## Security Analysis

| Area | Verdict |
| --- | --- |
| Reentrancy | **No issue detected** — storage lock + CEI on every money path |
| Solvency | **Invariant enforced** — see overview; tests assert it incl. fuzz/invariant suites |
| Rounding | Buys floor shares (pool-favoured); sells ceil required input; voided redeem floors — pool never drained by rounding |
| Early resolution | **Design consideration / trust assumption** — CPMM `resolve` may fire before `lockTime`; integrity rests on ADMIN_ROLE honesty (pool engine fixes this; this engine does not) |
| MEV | Slippage+deadline on buy/sell; `addFunding` lacks deadline; `removeFunding` has neither — documented gap |
| DoS | Loops bounded by MAX_OUTCOMES=16; `_sendNative` failures affect only caller's own payout |
| ERC-1155 hooks | Receiver callbacks run post-effects everywhere; guarded entry points |

## Upgradeability

None. Clones point at an immutable implementation; behaviour fixed at deployment.

## Deployment Information

Deployed only as clones (implementation deployed bare by
`ignition/modules/forecast.ts`). Clone addresses are emitted in `MarketCreated`.
Chain: Nurachain (1020). Individual market addresses: Not found in repository.

## Integration Guide

Quote with `calcBuy`/`calcSell` before trading; pass realistic `min*` and `deadline`.
After resolution read `winningOutcome()` then `redeem()` if holding winners.
Listen per market: `PredictionPlaced/Sold`, `MarketResolved`, `RewardClaimed`.
Common failures: `TradingLocked` after lockTime, `SlippageExceeded` under vol,
`InsufficientLiquidity` selling large size into skewed pools.

## Function Reference

| Function | Visibility | Mutability | Access | Purpose |
| --- | --- | --- | --- | --- |
| `initialize(controller,treasury,params)` | external | payable | Factory, once | Clone setup + seed liquidity |
| `buy(i,minOut,deadline)` | external | payable | Anyone (Open,<lock) | Buy outcome shares |
| `sell(i,ret,maxIn,deadline)` | external | nonpayable | Anyone (Open,<lock) | Sell shares for collateral |
| `addFunding(minLP)` | external | payable | Anyone (Open,<lock) | Add LP liquidity |
| `removeFunding(lpShares)` | external | nonpayable | LP | Redeem LP into outcome tokens |
| `mergeSets(amount)` | external | nonpayable | Anyone | Complete sets → collateral |
| `redeem()` | external | nonpayable | Token holders | Winner/refund payout |
| `pause/unpause/close/voidMarket` | external | nonpayable | Controller | Lifecycle |
| `resolve(w)` | external | nonpayable | Controller | Declare winner |
| `setTreasury(t)` | external | nonpayable | Controller | Fee sink |
| `winningOutcome/getReserves/getPrices/calcBuy/calcSell/outcomeName` | external | view | Anyone | Reads |

