# PredictionTreasury

## Contract Overview

| Property | Value |
| --- | --- |
| Contract name | `PredictionTreasury` |
| Solidity file | `contracts/forecast/PredictionTreasury.sol` |
| Solidity version | `0.8.24` exact (compiled with the forecast profile) |
| Contract type | Concrete fee sink (constructor-deployed, standalone) |
| Purpose | Receives protocol fees from prediction markets; owner withdraws accumulated native fees to a configurable recipient |
| Upgradeable / Proxy | No / No |

Markets forward their cut via `depositFee{value}(market)`; bare transfers are accepted by
`receive()` and attributed to the sender as a "market". Accounting is kept per source.

## Inheritance

```text
PredictionTreasury
├── IPredictionTreasury  -- implemented interface
├── Ownable2Step         -- two-step ownership handover (Ownable underneath)
└── ReentrancyGuard      -- guards withdraw
```

## Interfaces

`IPredictionTreasury`: `depositFee(address market) payable`, `withdraw(uint256)`,
`setFeeRecipient(address)`, plus views. Implemented in full here.

## State Variables

| Variable | Type | Visibility | Mutability | Purpose |
| --- | --- | --- | --- | --- |
| `_feeRecipient` | `address` | private | mutable | Destination of `withdraw` transfers. |
| `_totalCollected` | `uint256` | private | mutable | Lifetime fees (exposed via `totalCollected()`). |
| `_collectedFor` | `mapping(address => uint256)` | private | mutable | Key: originating market address → fees collected from it (`collectedFor(market)`). |

Inherited: `Ownable._owner`, `Ownable2Step._pendingOwner`.

## Structs / Enums

None.

## Constants & Immutables

None declared beyond inherited role machinery (no roles — plain `Ownable2Step`).

## Modifiers

| Modifier | Source | Used by | Effect |
| --- | --- | --- | --- |
| `onlyOwner` | Ownable | `withdraw`, `setFeeRecipient` | Owner-only administration |
| `nonReentrant` | ReentrancyGuard | `withdraw` | Blocks reentry around the payout |

## Events

| Event | Parameters | Indexed | Trigger |
| --- | --- | --- | --- |
| `FeeCollected` | `market, amount` | indexed `market` | Every `depositFee` / `receive`; `market` = declared origin or `msg.sender` for bare transfers |
| `FeeWithdrawn` | `to, amount` | none | Successful `withdraw` |
| `FeeRecipientChanged` | `recipient` | indexed | Constructor and `setFeeRecipient` |
| *(inherited)* `OwnershipTransferStarted`, `OwnershipTransferred` | — | — | Two-step handover |

## Errors

| Error | Trigger condition | Paths | Avoidance |
| --- | --- | --- | --- |
| `ZeroAddress()` | ctor recipient zero; `setFeeRecipient(0)` | constructor, setter | real address |
| `ZeroAmount()` | deposit of 0; withdraw of 0 | `depositFee`, `withdraw` | positive amounts |
| `InsufficientLiquidity()` | withdraw above balance | `withdraw` | smaller amount |
| `TransferFailed()` | recipient call fails | `withdraw` | use payable/EOA recipient |
| `OwnableUnauthorizedAccount` / `ERC1967Invalid...` n/a | non-owner calls guarded fns | guarded | be owner |

## Functions

### Classification

- **Financial:** `depositFee`, `receive`, `withdraw`
- **Administrative:** `withdraw`, `setFeeRecipient`, ownership functions
- **View:** `owner`, `pendingOwner`, `feeRecipient`, `totalCollected`, `collectedFor`

---

### depositFee

```solidity
function depositFee(address market) external payable;
```

Records `msg.value` against `market`, bumps totals, emits `FeeCollected`.
**Access:** anyone (markets call it; open by design so integrators can forward fees).
Reverts on zero value.

### receive

Accepts plain native transfers, attributing them to `msg.sender`. Emits `FeeCollected`.

---

### withdraw

```solidity
function withdraw(uint256 amount) external onlyOwner nonReentrant;
```

Sends `amount` native to `_feeRecipient` via low-level `call`. Checks: amount > 0,
balance sufficient. Emits `FeeWithdrawn(to, amount)` before the send.
**Security:** owner-only drain to a fixed recipient; reentrancy-guarded; a broken
recipient just reverts (funds stay).

---

### setFeeRecipient

```solidity
function setFeeRecipient(address recipient) external onlyOwner;
```

Zero-checked; emits `FeeRecipientChanged`. Note: wrong values are recoverable later
(owner-only), unlike botched immutable parameters.

---

### Views

```solidity
feeRecipient() -> address
totalCollected() -> uint256
collectedFor(market) -> uint256
owner(), pendingOwner(), acceptOwnership(), transferOwnership(to), renounceOwnership()
```
*(last five inherited from `Ownable2Step`.)*

## Access Control

| Function | Required role | Who |
| --- | --- | --- |
| `depositFee`, `receive` | none | Anyone |
| `withdraw`, `setFeeRecipient` | owner | Treasury owner |
| ownership transfer | owner (+ pending accept) | Two-step |

**CRITICAL ADMIN POWERS:** `withdraw` moves all accumulated fees. Ownership is two-step,
so a typo cannot brick it.

## Token / Financial Flow

```text
Market clone ──depositFee{value}──▶ Treasury balance ──withdraw──▶ feeRecipient
```

No approvals (native coin). Per-market attribution enables revenue dashboards.

## Security Analysis

- **Reentrancy:** guard + CEI ordering on withdraw.
- **Centralization:** single owner drains everything — expected for a treasury.
- **Griefing:** anyone can donate via `receive()` (recorded honestly); no harm beyond dust accounting noise.
- **No issue detected** otherwise; minimal surface.

## Deployment Information

Deployed by `ignition/modules/forecast.ts` with `(admin, feeRecipient)`; `admin` defaults
to deployer, `feeRecipient` defaults to admin and is fixable later via
`setFeeRecipient`. Chain Nurachain (1020); address recorded at deploy time
(Not found in repository).

## Integration Guide

Reads: `totalCollected()`, `collectedFor(market)` for analytics. Listen:
`FeeCollected` per market for revenue tracking, `FeeWithdrawn` for outflows.

## Function Reference

| Function | Visibility | Mutability | Access | Purpose |
| --- | --- | --- | --- | --- |
| `depositFee(market)` | external | payable | Anyone | Record fee from market |
| `receive()` | external | payable | Anyone | Accept bare transfers as fees |
| `withdraw(amount)` | external | nonpayable | Owner | Pay out to recipient |
| `setFeeRecipient(r)` | external | nonpayable | Owner | Change payout address |
| `feeRecipient/totalCollected/collectedFor` | external | view | Anyone | Reads |
| `transferOwnership/acceptOwnership/renounceOwnership/pendingOwner/owner` | public | nonpayable/view | Two-step | Ownership |
