# PredictionFactory

## Contract Overview

| Property | Value |
| --- | --- |
| Contract name | `PredictionFactory` |
| Solidity file | `contracts/forecast/PredictionFactory.sol` |
| Solidity version | `0.8.24` exact (compiled viaIR, cancun) |
| Contract type | Concrete clone factory + admin control plane + registry |
| Purpose | Deploys prediction markets as cheap EIP-1167 minimal-proxy clones of two engine implementations, keeps the canonical registry with status buckets and pagination, and relays every lifecycle action to the clones |
| Upgradeable / Proxy | Not itself; it *creates* EIP-1167 proxies of immutable implementations |

Two creation paths:

- `createMarket` (payable) — clones [`PredictionMarket`](PredictionMarket.md) (CPMM,
  ERC-1155 outcome shares, AMM trading). Seed value becomes initial LP liquidity.
- `createMarket2` (non-payable) — clones [`PredictionPool`](PredictionPool.md)
  (parimutuel betting; no LPs). Attached value is deliberately rejected because a pool
  needs no seed liquidity and attached value would be unrecoverable.

Every clone trusts the factory as its **controller**; lifecycle calls
(pause/close/resolve/void) go through the factory so the registry's per-market status
stays authoritative without frontends cross-calling clones.

## Inheritance

```text
PredictionFactory
└── AccessControl    -- DEFAULT_ADMIN_ROLE + ADMIN_ROLE granted to `admin` in ctor
```

Also uses OpenZeppelin `Clones` (library) and `EnumerableSet` (status buckets).

## Interfaces

| Interface | Interaction |
| --- | --- |
| `IPredictionFactory` | Implemented surface. |
| `IPredictionMarket` | Called on fresh clones: `initialize(...)`; lifecycle relay functions (`pause`, `unpause`, `close`, `resolve`, `voidMarket`, `setTreasury`) share identical signatures across both engines, so one interface drives both kinds of clone. |

## State Variables

| Variable | Type | Visibility | Mutability | Purpose |
| --- | --- | --- | --- | --- |
| `ADMIN_ROLE` | `bytes32` | public | constant | Role that creates and administers markets. |
| `BPS` | `uint16` | public | constant | `1e4` basis-point denominator. |
| `MAX_FEE_BPS` | `uint16` | public | constant | `1000`; caps total fee for new markets at 10%. |
| `marketImplementation` | `address` | public | **immutable** | CPMM implementation cloned by `createMarket`. |
| `poolImplementation` | `address` | public | **immutable** | Parimutuel implementation cloned by `createMarket2`. |
| `_treasury` | `address` | private | mutable | Treasury applied to newly created markets. |
| `defaultFeeBps` | `uint16` | public | mutable | Total fee inherited when market params pass `feeBps == 0`. This is how the fee percentage gets matched to a market's type/category. |
| `defaultProtocolFeeShareBps` | `uint16` | public | mutable | Protocol fee share inherited likewise (CPMM only; pools ignore it). |
| `_records` | `MarketRecord[]` | private | mutable | Registry indexed by marketId. |
| `_kinds` | `mapping(uint256 => MarketKind)` | private | mutable | marketId → engine (`Amm`=0 default, `Pool`=1). |
| `_byStatus` | `mapping(MarketStatus => EnumerableSet.UintSet)` | private | mutable | O(1) status transitions + paged filters per status. |

## Structs (declared in `PredictionTypes.sol`)

```text
MarketParams  (creation parameters passed into a clone's initializer)
├── title, description, category, imageURI : string   -- metadata
├── creator              : address  -- account credited as creator/first LP
├── lockTime             : uint64   -- trading/betting closes at this timestamp
├── resolveTime          : uint64   -- informational target resolution time
├── feeBps               : uint16   -- total fee; 0 ⇒ inherit factory default
├── protocolFeeShareBps  : uint16   -- treasury cut of each fee; 0 ⇒ inherit default
└── outcomeNames         : string[] -- 2..16 names; length defines outcome count

MarketRecord  (registry snapshot kept by the factory)
├── market      : address  -- clone address
├── creator     : address
├── title, category : string
├── status      : MarketStatus
├── createdAt, lockTime, resolveTime : uint64
└── outcomeCount: uint32
```

Used by `createMarket`/`createMarket2` (input + record) and all registry views.

## Enums (declared in `PredictionTypes.sol`)

```text
MarketKind : Amm(0), Pool(1)

MarketStatus:
  Open     (0) -- trading/liquidity live until lockTime
  Paused   (1) -- reversible halt by admin
  Closed   (2) -- permanent halt, awaiting resolution
  Resolved (3) -- winner declared; winning shares redeem 1:1
  Voided   (4) -- invalid resolution; refund basis
```

Status values drive the registry buckets and what users may do on a clone.

## Modifiers

| Modifier | Condition | Prevents | Used by |
| --- | --- | --- | --- |
| `onlyRole(ADMIN_ROLE)` | caller holds ADMIN_ROLE | non-admins creating/managing markets | all admin functions below |

## Events

| Event | Parameters | Indexed | Trigger |
| --- | --- | --- | --- |
| `MarketCreated` | `marketId, market, creator, category, outcomeCount, initialFunding` | first three | Successful `createMarket` (`initialFunding = msg.value`) or `createMarket2` (0) |
| `TreasuryUpdated` | `treasury` | indexed | `setTreasury` |
| `FeesUpdated` | `feeBps, protocolFeeShareBps` | none | `setDefaultFees` |

Trade/lifecycle events are emitted by the clones themselves (shared declarations in
`PredictionEvents.sol`); indexers should key off the clone address.

## Errors

| Error | Trigger condition | Paths |
| --- | --- | --- |
| `ZeroAddress()` | constructor: zero admin/treasury/either implementation; `setTreasury(0)` | constructor, `setTreasury` |
| `InvalidFee()` | `feeBps > MAX_FEE_BPS` or share > BPS | constructor, `setDefaultFees` |
| `AccessControlUnauthorizedAccount` *(OZ)* | missing ADMIN_ROLE | all guarded functions |
| clone validation errors bubble up | bad params rejected inside clone `initialize` (`InvalidOutcomeCount`, `InvalidTiming`, `InvalidFee`, ...) | `createMarket`, `createMarket2` (whole tx reverts atomically) |

## Functions

### Classification

- **Administrative:** `createMarket`, `createMarket2`, `pauseMarket`, `unpauseMarket`,
  `closeMarket`, `voidMarket`, `setTreasury`, `repointTreasury`,
  `setDefaultFees`
- **Resolution multisig:** confirmResolution (signers), setResolutionSigners (owner)
- **View:** marketCount, marketAt, marketAddress, marketKind, 	reasury, esolutionSigners, equiredConfirmations, confirmationCount, confirmationOf, isResolutionSigner,
  `marketsPaged`, `marketsByStatus`, `activeMarkets`, `closedMarkets`,
  `resolvedMarkets`, `countByStatus`
- **Private:** `_setStatus`

---

### createMarket

```solidity
function createMarket(MarketParams calldata params)
    external payable onlyRole(ADMIN_ROLE) returns (uint256 marketId, address market);
```

**Purpose:** Deploys a CPMM market clone, initializes it with `msg.value` as seed
liquidity, registers it.

**Parameters:** `params` — see struct above. `feeBps == 0` ⇒ inherits `defaultFeeBps`;
`protocolFeeShareBps == 0` ⇒ inherits default. **Returns:** new registry index and clone
address. external / payable / ADMIN_ROLE.

**Flow:** 1. copy params to memory, apply defaults for zero fields. 2.
`market = Clones.clone(marketImplementation)`. 3.
`IPredictionMarket(market).initialize{value: msg.value}(address(this), _treasury, effective)`
(validates 2..16 outcomes, `now < lockTime <= resolveTime`, fees ≤ caps; mints LP shares
to `params.creator`). 4. append `MarketRecord`, add to Open bucket. 5. emit `MarketCreated`.

**State changes:** `_records`, `_byStatus[Open]`. **Events:** `MarketCreated` (+ clone's
`LiquidityAdded`). **Errors:** see table; also any clone-init revert.

**Security:** initialization happens inside the same transaction as the clone creation —
no front-running window on `initialize`. Value is forwarded to the clone only.

---

### createMarket2

```solidity
function createMarket2(MarketParams calldata params)
    external onlyRole(ADMIN_ROLE) returns (uint256 marketId, address market);
```

Same as `createMarket` but: clones `poolImplementation`; **not payable** (reverts if value
attached — a pool needs no seed liquidity); only `feeBps == 0` default applies (pool
ignores `protocolFeeShareBps`); sets `_kinds[marketId] = MarketKind.Pool`.
Emits `MarketCreated(..., initialFunding = 0)`.

---

### Lifecycle relays

Each is `external onlyRole(ADMIN_ROLE)`, calls the identically-named function on the
clone, then updates the registry bucket via `_setStatus`. The clone reverts first if the
transition is illegal, so registry and clone can never disagree:
| Function | Clone call / effect | Registry transition |
| --- | --- | --- |
| `pauseMarket(marketId)` *(ADMIN_ROLE)* | `pause()` | Open → Paused |
| `unpauseMarket(marketId)` *(ADMIN_ROLE)* | `unpause()` | Paused → Open |
| `closeMarket(marketId)` *(ADMIN_ROLE)* | `close()` | → Closed (from not-ended states) |
| `confirmResolution(marketId, winningOutcome)` *(signer)* | records a vote; at quorum calls `resolve(winningOutcome)` | → Resolved |
| `voidMarket(marketId)` *(ADMIN_ROLE)* | `voidMarket()` | → Voided |

`marketId` out of range reverts with array-index panic.

### Resolution multisig (N-of-M)

Resolution — the one action that decides who gets paid — is gated behind an owner-appointed
signer set instead of a single admin key:

- **Setup:** constructor takes `initialSigners` (≤ `MAX_SIGNERS = 10`, unique, non-zero) and
  `requiredConfirmations` (`1 ≤ n ≤ signers.length`). Recommended production shape:
  **five signers, quorum three**. The owner can replace both atomically via
  `setResolutionSigners(signers, required)`.
- **Voting:** each signer calls `confirmResolution(marketId, outcome)` — one open vote per
  signer per market; re-voting a different outcome moves the tally
  (`ResolutionConfirmed` carries the running count).
- **Execution:** the moment any single outcome reaches `_required` distinct votes, the same
  transaction runs the clone's `resolve(winner)` — taking the house fee and unlocking
  winner payouts — flips the registry to Resolved, and emits `ResolutionExecuted`.
- **Guards:** non-signers revert `NotSigner`; ended markets revert `MarketAlreadyEnded`
  before any vote lands; unknown outcomes revert `InvalidOutcome`. Votes are never cleared,
  but a terminal market can never resolve twice.
- **Engine interaction:** pool clones refuse resolution before their `lockTime`
  (`LockNotReached`), so for pool markets the quorum can only execute after betting has
  locked; CPMM clones impose no such delay.

---

### setTreasury / repointTreasury / setDefaultFees

```solidity
function setTreasury(address treasury_) external;              // ADMIN_ROLE
function repointTreasury(uint256 marketId) external;           // ADMIN_ROLE
function setDefaultFees(uint16 feeBps, uint16 protocolFeeShareBps) external; // ADMIN_ROLE
```

- `setTreasury`: changes the treasury applied to *future* markets; zero check; emits
  `TreasuryUpdated`.
- `repointTreasury`: calls `setTreasury(_treasury)` on one existing clone so existing
  markets follow the factory's current treasury. Per-market (not a loop) to keep gas bounded.
- `setDefaultFees`: validates against `MAX_FEE_BPS`/`BPS`; affects markets that pass 0
  afterwards. Emits `FeesUpdated`.

---

### Registry views

| Function | Returns |
| --- | --- |
| `marketCount()` | `_records.length` |
| `marketAt(id)` / `marketAddress(id)` | record / clone address |
| `marketKind(id)` | `Amm` or `Pool` |
| `treasury()` | current `_treasury` |
| `marketsPaged(offset, limit)` | page of records; empty array when offset ≥ total |
| `marketsByStatus(status, offset, limit)` | paged ids from the status bucket resolved to records |
| `activeMarkets` / `closedMarkets` / `resolvedMarkets(offset, limit)` | convenience wrappers over `marketsByStatus(Open/Closed/Resolved, …)` |
| `countByStatus(status)` | bucket size |

Pagination clamps `end` to total; never reverts except `offset+limit` overflow panic
(unreachable in practice). Note: there is no paged accessor for `Voided` other than
`marketsByStatus(MarketStatus.Voided, ...)` directly.

---

### _setStatus (private)

Moves `marketId` between status buckets and writes the record's status. No-op when
`prev == next`.

## Access Control

| Function | Required role | Who |
| --- | --- | --- |
| all create/lifecycle/config functions | `ADMIN_ROLE` | Admin(s); role granted/revoked by DEFAULT_ADMIN_ROLE holder |
| all views | none | Anyone |

**CRITICAL ADMIN POWERS:** market creation (incl. choosing fees up to 10%), voiding,
treasury re-pointing, and — owner-only — replacing the resolution signer set/quorum.
Resolution itself requires the N-of-M signer quorum (e.g. 3-of-5), not a single key; a
colluding quorum is still a trusted assumption. See
[PredictionPool](PredictionPool.md)/[PredictionMarket](PredictionMarket.md)
for per-action consequences.

## Token / Financial Flow

```text
ADMIN ──createMarket{value}──▶ clone.initialize (seed = LP shares to creator)
Users ──buy/sell/bet──▶ clone ──protocol cut──▶ Treasury
Signers ×N ──confirmResolution(id,outcome)──▶ quorum? ──▶ clone.resolve ──fee──▶ Treasury
Winners ──redeem()/claim()──◀ clone balance
```

The factory itself never holds funds beyond transiently forwarding `msg.value` in
`createMarket`.

## External Contract Interactions

| Target | Call | Why | Failure behaviour |
| --- | --- | --- | --- |
| fresh EIP-1167 clone (`Clones.clone`) | `initialize{value}` / lifecycle fns | create + drive markets | revert bubbles; whole tx atomic |

## Security Analysis

- **Initialization race:** none — `Clones.clone` + `initialize` are atomic in one tx;
  implementations call `_disableInitializers()` in their constructors.
- **Centralization:** resolution needs an N-of-M signer quorum (e.g. 3-of-5) rather than one
  key, but a colluding quorum or the owner replacing the set remain trusted assumptions; no dispute window or oracle
  integration. Documented trust assumption.
- **Registry consistency:** guaranteed by ordering (clone state change first, then
  `_setStatus`); a failing relay leaves both untouched (atomic).
- **No issue detected:** reentrancy (no untrusted external calls), integer issues
  (0.8 checked), fee griefing (capped at 10%).

## Upgradeability

Factory and both implementations are immutable once deployed. "Upgrading" an engine means
deploying a new implementation + new factory; existing clones permanently point at their
controller (this factory).

## Deployment Information

- Network: Nurachain (1020). Address: Not found in repository (recorded at deploy time).
- Deploy: `npm run deploy:nurachain:forecast` → `ignition/modules/forecast.ts`
  (deploys Treasury, both implementations bare — constructors `_disableInitializers()` —
  then the Factory wired to them; `admin` defaults to deployer, receives both roles).

## Integration Guide

Reads: `activeMarkets`, `marketsPaged`, `marketAt`, `marketKind`.
Admin flow (e.g. via the web admin panel): `createMarket2` for pool markets → users call
`bet` on the clone → after `lockTime`, signers call `confirmResolution(id, outcome)` until the quorum agrees → winners
call `claim()` on the clone.
Listen: `MarketCreated` (new listings), plus clone events per market.
Common failures: `AccessControlUnauthorizedAccount` (not admin), timing validation on
creation (`InvalidTiming`).

## Function Reference

| Function | Visibility | Mutability | Access | Purpose |
| --- | --- | --- | --- | --- |
| `createMarket(params)` | external | payable | ADMIN_ROLE | Deploy CPMM clone with seed |
| `createMarket2(params)` | external | nonpayable | ADMIN_ROLE | Deploy parimutuel clone |
| `pauseMarket/unpauseMarket/closeMarket/voidMarket(id)` | external | nonpayable | ADMIN_ROLE | Relay lifecycle to clone |
| `confirmResolution(id,outcome)` | external | nonpayable | Resolution signer | Vote winner; executes at quorum |
| `setResolutionSigners(signers,n)` | external | nonpayable | Factory owner | Replace signer set + quorum |
| `resolutionSigners/isResolutionSigner/requiredConfirmations/confirmationCount/confirmationOf` | external | view | Anyone | Multisig state reads |
| `setTreasury(t)` | external | nonpayable | ADMIN_ROLE | Treasury for future markets |
| `repointTreasury(id)` | external | nonpayable | ADMIN_ROLE | Sync one clone's treasury |
| `setDefaultFees(f,s)` | external | nonpayable | ADMIN_ROLE | Defaults for feeBps=0 markets |
| `marketCount/marketAt/marketAddress/marketKind/treasury` | external | view | Anyone | Registry reads |
| `marketsPaged/marketsByStatus/activeMarkets/closedMarkets/resolvedMarkets/countByStatus` | external/public | view | Anyone | Paged listing |

