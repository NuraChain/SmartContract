# PredictionPool

## Contract Overview

| Property | Value |
| --- | --- |
| Contract name | `PredictionPool` |
| Solidity file | `contracts/forecast/PredictionPool.sol` |
| Solidity version | `0.8.24` exact (compiled viaIR, cancun) |
| Contract type | Concrete parimutuel prediction market; deployed as an **EIP-1167 clone** by [`PredictionFactory.createMarket2`](PredictionFactory.md), initialized exactly once |
| Purpose | Participants bet native collateral directly on an outcome while Open and pre-`lockTime`; afterwards an admin declares the winner; the house fee is deducted once off the whole pool; the remainder is shared pro-rata among the winning outcome's backers |

```text
payout(user) = (totalPool − fee) · stakeOnWinner(user) / totalStakedOnWinner
```

No trading, no shares, no liquidity providers. `params.protocolFeeShareBps` is ignored:
the full fee goes to the treasury because there are no LPs to retain a cut for.

## Inheritance

```text
PredictionPool
├── IPredictionPool  -- implemented interface
└── Initializable    -- clone-initialization guard
```

## Interfaces

| Interface | Interaction |
| --- | --- |
| `IPredictionPool` | Implemented surface. |
| `IPredictionTreasury` | `depositFee{value}` at resolution. |

## State Variables

| Variable | Type | Visibility | Mutability | Purpose |
| --- | --- | --- | --- | --- |
| `MAX_OUTCOMES` | `uint256` | public | constant | `16`; bounds per-outcome loops (incl. void-refund loop in `claim`). |
| `MAX_FEE_BPS` | `uint16` | public | constant | `1000`; house fee ≤ 10%. |
| `CLAIM_WINDOW` | `uint64` | public | constant | `365 days`; how long after settlement winners may still `claim`. |
| `AUTO_DISTRIBUTE_BATCH` | `uint256` | public | constant | `20`; payouts pushed inside the settling transaction itself. |
| `PUSH_GAS` | `uint256` | private | constant | `50_000`; gas forwarded to each pushed payout. |
| `controller` / `treasury` / `status` / metadata / `creator` / timestamps / `feeBps` | — | public | set-once | Same shapes as [PredictionMarket](PredictionMarket.md); `protocolFeeShareBps` stored for parameter-shape parity but unused. |
| `categoryId` | `uint32` | public | set-once | Category this market is filed under, in the [factory's registry](PredictionFactory.md#category-registry). The market stores no category name of its own. |
| `autoDistribute` | `bool` | public | mutable | Whether settlement pushes payouts by itself. **`false` until an admin turns it on.** Never gates the money. |
| `endedAt` | `uint64` | public | set at resolve/void | Settlement timestamp; `0` while live. Anchors the claim window. |
| `outcomeCount` | `uint256` | public | set-once | n outcomes. |
| `_outcomeNames` | `string[]` | private | set-once | Display names. |
| `totalPool` | `uint256` | public | mutable | Total collateral bet across all outcomes. |
| `_distributable` | `uint256` | private | set at resolve | Pool minus fee, available to winners. |
| `_winningOutcome` | `uint256` | private | set at resolve | Meaningful only when Resolved. |
| `_stakedFor` | `mapping(uint256 => uint256)` | private | mutable | Key: outcome → total staked on it. |
| `_stakeOf` | `mapping(address => mapping(uint256 => uint256))` | private | mutable | Keys: account → outcome → stake of that account on that outcome. |
| `_claimed` | `mapping(address => bool)` | private | mutable | One-shot payment flag per account — set by a push as well as by a pull, or when the account had nothing coming. |
| `_participants` | `address[]` | private | append-only | Every account that has ever bet, in first-bet order; the distribution walks it. |
| `_totalStakeOf` | `mapping(address => uint256)` | private | mutable | Stake across all outcomes; doubles as the void-refund amount and as the first-bet test that keeps `_participants` free of duplicates. |
| `_cursor` | `uint256` | private | mutable | How far the push has walked `_participants`. |
| `_credited` | `mapping(address => uint256)` | private | mutable | Payouts a push could not deliver, waiting to be pulled by `claim`. |
| `_entered` | `uint256` | private | mutable | Storage reentrancy lock (1 free / 2 entered); =1 after initialize. |

## Structs / Enums

Shared types from `PredictionTypes.sol`: `MarketParams`, `MarketStatus`
(see [PredictionFactory](PredictionFactory.md)).

## Modifiers

| Modifier | Condition | Prevents | Used by |
| --- | --- | --- | --- |
| `onlyController` | caller == factory | unauthorized lifecycle | pause/unpause/close/resolve/voidMarket/setTreasury |
| `nonReentrant` | lock free | reentrancy on money paths | resolve, bet, claim |

## Events

| Event | Parameters | Indexed | Trigger |
| --- | --- | --- | --- |
| `BetPlaced` | `market, better, outcome, amount` | first three | Successful `bet` |
| `RewardClaimed` | `market, claimant, amount` | market, claimant | Successful `claim` |
| `MarketPaused/Unpaused/Closed/Voided/Resolved` | see shared events | — | Lifecycle |
| `UnclaimedSwept` | `market, treasury, amount` | market, treasury | `sweepUnclaimed`; kept apart from `FeeCollected` so residue never reads as house revenue |
| `PayoutDeferred` | `market, account, amount` | market, account | A pushed payout could not be delivered; `amount` was credited for the account to pull instead |
| `DistributionAdvanced` | `market, cursor, total, amount` | market | Every push batch, including the one inside settlement |
| `AutoDistributeSet` | `market, enabled` | market | `setAutoDistribute` |

## Errors

Distinctive ones beyond the shared set (see [PredictionMarket](PredictionMarket.md) table
for the common list):

| Error | Trigger condition | Paths |
| --- | --- | --- |
| `LockNotReached()` | resolution attempted while `block.timestamp < lockTime` | `resolve`. **Stricter than the CPMM on purpose:** every late bet would change everyone's payout, so the pool cannot settle early |
| `NothingToClaim()` | already claimed; zero stake on winner; zero total stake; not terminal | `claim`, `winningOutcome`(indirect) |
| `ClaimWindowOpen()` | sweep attempted before `endedAt + CLAIM_WINDOW` | `sweepUnclaimed` |
| `ClaimWindowClosed()` | claim attempted at/after `endedAt + CLAIM_WINDOW` | `claim` |

## Functions

### Classification

- **User / Financial:** `bet`, `claim`
- **Permissionless keeper:** `distribute`
- **Administrative (controller-only):** `pause`, `unpause`, `close`, `resolve`,
  `voidMarket`, `setTreasury`, `setAutoDistribute`, `sweepUnclaimed`, `initialize`
  (factory once)
- **View:** `winningOutcome`, `claimDeadline`, `distributionProgress`, `pendingPayout`,
  `participantCount`, `stakedFor`, `myStake`, `distributableAmount`, `previewPayout`,
  `impliedOdds`, `outcomeName`, `totalPool` (+ status/outcomeCount/endedAt/categoryId)

---

### initialize

```solidity
function initialize(address controller_, address treasury_, MarketParams calldata params)
    external initializer;
```

Not payable (pool needs no seed). Validates addresses, outcome count 2..16,
fees (`feeBps ≤ MAX_FEE_BPS`, share ≤ BPS), timing (`now < lockTime ≤ resolveTime`);
sets `_entered = 1`; copies config; pushes outcome names. Called by the factory inside
`createMarket2`; implementation constructor runs `_disableInitializers()`.

---

### bet

```solidity
function bet(uint256 outcomeIndex) external payable nonReentrant returns (uint256 staked);
```

**Access:** anyone while `status == Open` **and** `block.timestamp < lockTime`.

**Flow:** status check → lock check → index check → `staked = msg.value ≠ 0` →
effects only: `_stakeOf[sender][i] += staked; _stakedFor[i] += staked; totalPool += staked`
→ emit `BetPlaced`.

Returns the recorded stake. No reentrancy exposure (no external calls).

---

### resolve

```solidity
function resolve(uint256 winningOutcome_) external onlyController nonReentrant;
```

Declares the winner **only after lockTime**. Flow: `_requireNotEnded` →
`block.timestamp < lockTime → LockNotReached` → index check → write `_winningOutcome`,
set Resolved → compute `fee = pool·feeBps/BPS` (floored), `_distributable = pool - fee` →
forward fee to treasury via `IPredictionTreasury.depositFee{value}` → emit
`MarketResolved`.

**Security note:** if the admin declares an outcome with **zero total stake**, every
future `claim()` reverts at the `mine == 0` check before reaching the division — the
prize becomes permanently unclaimable (admin-error path; funds frozen, not stealable).
Admins must declare an outcome that actually has stakes.

---

### claim

```solidity
function claim() external nonReentrant returns (uint256 payout);
```

The **pull** path, and the default one: a pool pays on request unless an admin has switched
on the push at settlement (see below). Even then, this is what an account uses when the push
could not reach it — or whenever it simply prefers to collect its own share.

- **A waiting credit** (a push tried and the transfer failed) is paid first and in full.
- **Resolved:** `payout = myStakeOn(winner) · _distributable / stakedFor(winner)`
  (floored; dust stays in contract). Zero stake on winner ⇒ `NothingToClaim`.
- **Voided:** the caller's total stake across all outcomes (exact refund, fee-free).
- Otherwise ⇒ `MarketNotResolved`.

Effects first (`_claimed[sender] = true`) then `_sendNative(sender, payout)`; emits
`RewardClaimed`. Double payment is impossible by construction — the flag is the same one a
push sets. Claiming stops at `claimDeadline()` with `ClaimWindowClosed` (see
`sweepUnclaimed`).

---

### distribute

```solidity
function distribute(uint256 limit) external nonReentrant returns (uint256 paid);
```

The **push** path: bettors are paid without doing anything at all.

`distribute` is **permissionless** — a keeper, a frontend, or an impatient bettor may all
call it, and on a pool left at its defaults it is the only thing that pays anyone without
them asking.

Switch `autoDistribute` on and `resolve`/`voidMarket` also call it internally for
`AUTO_DISTRIBUTE_BATCH` accounts in the settling transaction, so a pool with few bettors is
emptied the moment an admin settles it; `distribute` then carries any remainder.

Each account is marked paid *before* its transfer and paid with `PUSH_GAS` forwarded. A
transfer that fails does not revert the batch: the amount becomes a `_credited` balance,
`PayoutDeferred` is logged, and the walk continues. One hostile recipient therefore cannot
stall the queue behind it. Losing bettors are marked and skipped at no cost.

---

### setAutoDistribute

```solidity
function setAutoDistribute(bool enabled) external onlyController;
```

Turns the push at settlement on or off for this pool. **Pools start with it off**, so this
is the opt-in. It is a convenience switch, not an access gate: with it off, `distribute` is
still open to anyone and `claim` still lets a bettor collect their own share — settlement
just does not start paying by itself. Emits `AutoDistributeSet`.

---

### sweepUnclaimed

```solidity
function sweepUnclaimed() external onlyController nonReentrant returns (uint256 amount);
```

Settlement (`resolve` or `voidMarket`) stamps `endedAt`, starting a `CLAIM_WINDOW` of
one year during which `claim` works exactly as before and nothing can be taken out of
the pool. At `claimDeadline()` the window flips: `claim` reverts `ClaimWindowClosed`
for everyone, and the admin may collect what is left.

- Reverts `MarketNotResolved` while `endedAt == 0` (a live pool is never sweepable).
- Reverts `ClaimWindowOpen` before the deadline; `ZeroAmount` when nothing is left.
- Sweeps the entire balance: unclaimed winner shares, void refunds nobody came back
  for, and the sub-unit rounding dust every pro-rata payout leaves behind. Zeroes
  `_distributable`, forwards via `IPredictionTreasury.depositFee`, emits
  `UnclaimedSwept`.

This also un-bricks the one documented admin-error case: a market resolved to a
zero-stake outcome no longer strands its pool forever.

---

### Lifecycle (controller-only)

`pause()/unpause()` (Open↔Paused betting halt), `close()` (permanent stop ahead of
resolution — note this does NOT enable early resolution), `voidMarket()`
(everyone refunds their own stake), `setTreasury(t)`, `sweepUnclaimed()`. Same guard
semantics as [PredictionMarket](PredictionMarket.md).

---

### Views

```solidity
winningOutcome()                     // reverts unless Resolved
claimDeadline()                      // endedAt + CLAIM_WINDOW, or 0 while live
endedAt()                            // settlement timestamp, or 0 while live
stakedFor(i)                         // total staked on outcome i
myStake(i)                           // caller's stake on i
distributableAmount()                // prize pool after fee (0 pre-resolve)
previewPayout(i)                     // hypothetical: if resolved now to i, my payout
impliedOdds(i)                       // stake share of whole pool, WAD (1e18)
distributionProgress()               // (cursor, total) of the automatic payout walk
pendingPayout(account)               // waiting credit, else this account's share
participantCount()                   // length of the distribution list
autoDistribute(), categoryId()       // push-at-settlement flag; factory category id
totalPool(), outcomeName(i), status(), outcomeCount()
```

`previewPayout`/`impliedOdds` are informational — the real pool grows until lockTime and
resolution fixes the numbers.

## Access Control

| Function | Required role | Who |
| --- | --- | --- |
| `bet` | none | Anyone (Open, pre-lock) |
| `claim` | none | Stakeholders, once each, until `claimDeadline()` |
| `distribute` | none | **Anyone** — it only moves settled collateral to the accounts already entitled to it |
| lifecycle + `initialize` | controller (factory) | ADMIN_ROLE upstream |

## Token / Financial Flow

```text
Bettors ──bet{value}──▶ totalPool (per-outcome accounting)
ADMIN ──resolve(w) after lockTime──▶ fee = pool·feeBps/BPS ──▶ Treasury
                                    └─ distributable ──▶ winners pro-rata
     (autoDistribute on) ──▶ first batch pushed to their wallets in the settling tx
Anyone ──distribute(limit)──▶ walks the same list, on or off
Undeliverable ──▶ credited ──▶ Winner ──claim──▶ native     (until claimDeadline())
Void path: ADMIN ──voidMarket──▶ each bettor refunds own full stake, fee-free
After claimDeadline(): ADMIN ──sweepUnclaimed──▶ whole remaining balance ──▶ Treasury
```

No approvals needed (native coin). Rounding floors payouts in the pool's favour. Every path
out of the contract settles the same accounting; the only difference is who pays the gas.

## External Contract Interactions

| Target | Call | Failure behaviour |
| --- | --- | --- |
| `IPredictionTreasury` | `depositFee{value}(market)` at resolve, and again on `sweepUnclaimed` | revert bubbles → resolution/sweep blocked until treasury healthy (trusted infra) |
| `payable(account).call` | claim payout | `TransferFailed`; affects only that claimer |

## Security Analysis

| Area | Verdict |
| --- | --- |
| Reentrancy | **No issue detected** — CEI everywhere; `nonReentrant` on resolve/bet/claim; bets make no external calls |
| Double-claim | Impossible — one-shot `_claimed` flag written before transfer |
| Early-resolution manipulation | **Fixed vs CPMM** — `LockNotReached` prevents settling before betting closes |
| Rounding | Floors favour the pool; sub-unit dust remains in contract |
| Admin error | **Partly mitigated** — resolving a zero-stake outcome still bricks claims, but the pool is no longer stranded forever: `sweepUnclaimed` recovers it to the treasury a year on. Centralized resolution otherwise trusted |
| Unclaimed funds | Bounded — a settled pool cannot hold coins indefinitely; after a one-year claim window the residue is recoverable by an admin, and the cut-off is the deadline, not the sweep tx, so it is identical for every claimant |
| DoS | Loops bounded by 16 outcomes, and by the caller's `limit` in `distribute`; a failed push is credited rather than retried, so no recipient can stall the queue |

## Upgradeability

None. Immutable clone semantics like the CPMM engine.

## Deployment Information

Deployed as clones by `createMarket2` (implementation deployed bare by
`ignition/modules/forecast.ts`). Clone addresses emitted in `MarketCreated` with
`initialFunding = 0`. Individual markets: Not found in repository.

## Integration Guide

Read `impliedOdds(i)` for live odds, `myStake(i)`/`previewPayout(i)` for user UI.
Flow: wait `status == Open && timestamp < lockTime` → `bet{value}(i)` → listen for
`MarketResolved(market, w)` → winners call `claim()`.
Common failures: `TradingLocked` (after lock), `MarketNotOpen` (paused/closed),
`AlreadyClaimed`-style `NothingToClaim`, resolution impossible before lock.

## Function Reference

| Function | Visibility | Mutability | Access | Purpose |
| --- | --- | --- | --- | --- |
| `initialize(controller,treasury,params)` | external | nonpayable | Factory, once | Clone setup |
| `bet(outcomeIndex)` | external | payable | Anyone (Open,<lock) | Stake native on an outcome |
| `claim()` | external | nonpayable | Stakeholders | Winner payout or void refund, once |
| `pause/unpause/close/voidMarket/setTreasury` | external | nonpayable | Controller | Lifecycle/config |
| `resolve(w)` | external | nonpayable | Controller | Declare winner after lock; take fee |
| `setAutoDistribute(bool)` | external | nonpayable | Controller | Push at settlement on/off |
| `distribute(limit)` | external | nonpayable | **Anyone** | Pay up to `limit` more bettors |
| `sweepUnclaimed()` | external | nonpayable | Controller | Residue → treasury, post-claim-window |
| `winningOutcome/claimDeadline/endedAt/distributionProgress/pendingPayout/participantCount/autoDistribute/categoryId/stakedFor/myStake/distributableAmount/previewPayout/impliedOdds/outcomeName/totalPool` | external | view | Anyone | Reads |
