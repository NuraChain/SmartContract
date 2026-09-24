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

No trading, no shares, no liquidity providers. The full fee goes to the treasury.

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
| `MAX_OUTCOMES` | `uint256` | public | constant | `16`; bounds per-outcome loops (incl. cancel-refund loop in `claim`). |
| `MAX_FEE_BPS` | `uint16` | public | constant | `1000`; house fee ≤ 10%. |
| `CLAIM_WINDOW` | `uint64` | public | constant | `365 days`; how long after settlement winners may still `claim`. |
| `controller` / `treasury` / `status` / metadata / `creator` / timestamps / `feeBps` | — | public | set-once | Same shapes as [PredictionMarket](PredictionMarket.md). |
| `categoryId` | `uint32` | public | set-once | Category this market is filed under, in the [factory's registry](PredictionFactory.md#category-registry). The market stores no category name of its own. |
| `endedAt` | `uint64` | public | set at resolve/cancel | Settlement timestamp; `0` while live. Anchors the claim window. |
| `outcomeCount` | `uint256` | public | set-once | n outcomes. |
| `_outcomeNames` | `string[]` | private | set-once | Display names. |
| `totalPool` | `uint256` | public | mutable | Total collateral bet across all outcomes. |
| `_distributable` | `uint256` | private | set at resolve | Pool minus fee, available to winners. |
| `_winningOutcome` | `uint256` | private | set at resolve | Meaningful only when Resolved. |
| `_stakedFor` | `mapping(uint256 => uint256)` | private | mutable | Key: outcome → total staked on it. |
| `_stakeOf` | `mapping(address => mapping(uint256 => uint256))` | private | mutable | Keys: account → outcome → stake of that account on that outcome. |
| `_claimed` | `mapping(address => bool)` | private | mutable | One-shot payment flag per account. |
| `_totalStakeOf` | `mapping(address => uint256)` | private | mutable | Stake across all outcomes: exactly what a cancellation pays back. Read via `stakeOf`. |
| `_entered` | `uint256` | private | mutable | Storage reentrancy lock (1 free / 2 entered); =1 after initialize. |

## Structs / Enums

Shared types from `PredictionTypes.sol`: `MarketParams`, `MarketStatus`
(see [PredictionFactory](PredictionFactory.md)).

## Modifiers

| Modifier | Condition | Prevents | Used by |
| --- | --- | --- | --- |
| `onlyController` | caller == factory | unauthorized lifecycle | pause/unpause/close/resolve/cancelMarket/setTreasury |
| `nonReentrant` | lock free | reentrancy on money paths | resolve, bet, claim |

## Events

| Event | Parameters | Indexed | Trigger |
| --- | --- | --- | --- |
| `BetPlaced` | `market, better, outcome, amount` | first three | Successful `bet` |
| `RewardClaimed` | `market, claimant, amount` | market, claimant | Successful `claim` |
| `MarketPaused/Unpaused/Closed/Cancelled/Resolved` | see shared events | — | Lifecycle |
| `UnclaimedSwept` | `market, treasury, amount` | market, treasury | `sweepUnclaimed`; kept apart from `FeeCollected` so residue never reads as house revenue |


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
- **Administrative (controller-only):** `pause`, `unpause`, `close`, `resolve`,
  `cancelMarket`, `setTreasury`, `sweepUnclaimed`, `initialize` (factory once)
- **View:** `winningOutcome`, `claimDeadline`, `pendingPayout`, `stakeOf`,
  `stakedFor`, `myStake`, `distributableAmount`, `previewPayout`,
  `impliedOdds`, `outcomeName`, `totalPool` (+ status/outcomeCount/endedAt/categoryId)

**Nothing is ever pushed.** Settlement only fixes who is owed what; every wei leaves the
pool through a bettor's own `claim`.

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

The only way collateral leaves a settled pool. Nothing is pushed; every bettor comes and
takes their own share, once.

- **Resolved:** `payout = myStakeOn(winner) · _distributable / stakedFor(winner)`
  (floored; dust stays in contract). Zero stake on winner ⇒ `NothingToClaim`.
- **Cancelled:** the caller's total stake across all outcomes — their own money back, in full
  and fee-free, whichever outcome they backed. The house fee is only ever taken at
  resolution, so a cancelled pool has never charged one.
- Otherwise ⇒ `MarketNotResolved`.

Effects first (`_claimed[sender] = true`) then `_sendNative(sender, payout)`; emits
`RewardClaimed`. Double payment is impossible by construction. Claiming stops at
`claimDeadline()` with `ClaimWindowClosed` (see `sweepUnclaimed`).

---

### sweepUnclaimed

```solidity
function sweepUnclaimed() external onlyController nonReentrant returns (uint256 amount);
```

Settlement (`resolve` or `cancelMarket`) stamps `endedAt`, starting a `CLAIM_WINDOW` of
one year during which `claim` works exactly as before and nothing can be taken out of
the pool. At `claimDeadline()` the window flips: `claim` reverts `ClaimWindowClosed`
for everyone, and the admin may collect what is left.

- Reverts `MarketNotResolved` while `endedAt == 0` (a live pool is never sweepable).
- Reverts `ClaimWindowOpen` before the deadline; `ZeroAmount` when nothing is left.
- Sweeps the entire balance: unclaimed winner shares, cancellation refunds nobody came back
  for, and the sub-unit rounding dust every pro-rata payout leaves behind. Zeroes
  `_distributable`, forwards via `IPredictionTreasury.depositFee`, emits
  `UnclaimedSwept`.

This also un-bricks the one documented admin-error case: a market resolved to a
zero-stake outcome no longer strands its pool forever.

---

### Lifecycle (controller-only)

`pause()/unpause()` (Open↔Paused betting halt), `close()` (permanent stop ahead of
resolution — note this does NOT enable early resolution), `cancelMarket()`
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
pendingPayout(account)               // this account's share, 0 while live or once paid
stakeOf(account)                     // total stake across outcomes; what a cancellation refunds
categoryId()                         // factory category id
totalPool(), outcomeName(i), status(), outcomeCount()
```

`previewPayout`/`impliedOdds` are informational — the real pool grows until lockTime and
resolution fixes the numbers.

## Access Control

| Function | Required role | Who |
| --- | --- | --- |
| `bet` | none | Anyone (Open, pre-lock) |
| `claim` | none | Stakeholders, once each, until `claimDeadline()` |
| lifecycle + `initialize` | controller (factory) | ADMIN_ROLE upstream |

## Token / Financial Flow

```text
Bettors ──bet{value}──▶ totalPool (per-outcome accounting)
ADMIN ──resolve(w) after lockTime──▶ fee = pool·feeBps/BPS ──▶ Treasury
                                    └─ distributable ──▶ winners pro-rata
Bettor ──claim──▶ native      (their own share only, once, until claimDeadline())
Cancel path: ADMIN ──cancelMarket──▶ each bettor claims own full stake back, fee-free
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
| DoS | Loops bounded by 16 outcomes; a failed transfer reverts only the claimant's own call, so no account can affect another's |

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
| `claim()` | external | nonpayable | Stakeholders | Winner payout or cancellation refund, once |
| `pause/unpause/close/cancelMarket/setTreasury` | external | nonpayable | Controller | Lifecycle/config |
| `resolve(w)` | external | nonpayable | Controller | Declare winner after lock; take fee |
| `sweepUnclaimed()` | external | nonpayable | Controller | Residue → treasury, post-claim-window |
| `winningOutcome/claimDeadline/endedAt/pendingPayout/stakeOf/categoryId/stakedFor/myStake/distributableAmount/previewPayout/impliedOdds/outcomeName/totalPool` | external | view | Anyone | Reads |
