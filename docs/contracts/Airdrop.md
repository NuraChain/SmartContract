# Airdrop

## Contract Overview

| Property | Value |
| --- | --- |
| Contract name | `Airdrop` |
| Solidity file | `contracts/airdrop/Airdrop.sol` |
| Solidity version | `^0.8.28` (solc 0.8.28, cancun) |
| Contract type | Concrete, standalone (constructor-deployed) |
| Purpose | Pays a fixed amount of **native coin** to the first `maxClaims` eligible addresses; one claim per address, gated by an EIP-712 signature from a backend key |
| Upgradeable / Proxy | No / No |
| License | MIT |

Eligibility is proven entirely off-chain: a backend key holding `SIGNER_ROLE` signs an
EIP-712 `Claim(account, deadline)` message. Without it, "one claim per address" would be
worthless since anyone can generate unlimited addresses. On-chain checks only stop double
claims and cap overruns.

The contract pays from its **own native balance** and must be funded with at least
`maxClaims × rewardAmount` before claiming (via `fund()` or plain transfers).

## Inheritance

```text
Airdrop
├── AccessControl    -- DEFAULT_ADMIN_ROLE, PAUSER_ROLE, SIGNER_ROLE
├── Pausable         -- global claim halt
├── ReentrancyGuard  -- guards getReward / withdraw value paths
└── EIP712           -- domain separator for signed claims ("Airdrop", "1")
```

| Base | Why inherited |
| --- | --- |
| `AccessControl` | Role gating for admin/pauser/signer keys. |
| `Pausable` | `whenNotPaused` on `getReward`; kill switch during incidents. |
| `ReentrancyGuard` | `nonReentrant` around the payout in `getReward`/`withdraw`. |
| `EIP712` | Builds the domain separator binding signatures to this contract + this chain, so they cannot be replayed against another deployment or fork. |

## Interfaces

- `IERC1271` behaviour via OZ `AccessControl`? No — signature checks use `ECDSA.tryRecover`
  directly (EOA keys only). Contracts cannot hold SIGNER_ROLE effectively.
- No external interfaces consumed; pays out with `Address.sendValue`.

## State Variables

| Variable | Type | Visibility | Mutability | Purpose |
| --- | --- | --- | --- | --- |
| `SIGNER_ROLE` | `bytes32` | public | constant | Role that may sign eligibility payloads. |
| `PAUSER_ROLE` | `bytes32` | public | constant | Role that may pause/unpause claiming. |
| `CLAIM_TYPEHASH` | `bytes32` | private | constant | `keccak256("Claim(address account,uint256 deadline)")` — the EIP-712 struct hash. |
| `maxClaims` | `uint256` | public | **immutable** | Hard cap on total claims. Immutable so the promise cannot be inflated later. |
| `rewardAmount` | `uint256` | public | mutable | Native wei paid per claim (admin-adjustable, forward-only effect). |
| `totalClaims` | `uint256` | public | mutable | Claims made so far; also the ordinal of the next claim. |
| `hasClaimed` | `mapping(address => bool)` | public | mutable | Key: claimant address → true once claimed. Enforces one-claim-per-address forever. |

## Structs / Enums

None.

## Constants

See table above (`CLAIM_TYPEHASH`). EIP-712 domain: name `"Airdrop"`, version `"1"`,
plus chainId and verifyingContract (from OZ `EIP712`, cached in immutables).

## Modifiers

| Modifier | Source | Condition | Prevents | Used by |
| --- | --- | --- | --- | --- |
| `onlyRole(role)` | AccessControl | caller holds role | unauthorized admin | `setRewardAmount`, `pause`, `unpause`, `withdraw` |
| `whenNotPaused` | Pausable | not paused | claims during freeze | `getReward` |
| `nonReentrant` | ReentrancyGuard | guard slot free | reentrancy into payout | `getReward`, `withdraw` |

## Events

| Event | Parameters | Indexed | Trigger |
| --- | --- | --- | --- |
| `RewardClaimed` | `account, amount, claimNumber` | `account` | Successful `getReward`; `claimNumber` = running count (1-based) |
| `RewardAmountUpdated` | `previousAmount, newAmount` | none | `setRewardAmount` |
| `Funded` | `from, amount` | `from` | `fund()` or any plain transfer (`receive`) |
| `Withdrawn` | `to, amount` | none | Admin `withdraw` |

## Errors

| Error | Triggered when | Callable paths | Avoidance |
| --- | --- | --- | --- |
| `ZeroAddress()` | constructor admin/signer zero; `withdraw` to zero | constructor, `withdraw` | pass real addresses |
| `ZeroAmount()` | constructor `maxClaims_==0 ∥ rewardAmount_==0`; `fund()` value 0; `setRewardAmount(0)`; `withdraw(0)` | constructor, `fund`, `setRewardAmount`, `withdraw` | positive values |
| `AlreadyClaimed(account)` | `hasClaimed[msg.sender]` | `getReward` | one claim per address, ever |
| `AirdropFull(maxClaims)` | `totalClaims >= maxClaims` | `getReward` | none — cap is immutable |
| `SignatureExpired(deadline)` | `block.timestamp > deadline` | `getReward` | fresh signature |
| `InvalidSignature()` | ECDSA recover failed OR recovered signer lacks SIGNER_ROLE | `getReward` | correct EIP-712 signing by backend |
| `InsufficientBalance(available, required)` | contract balance < reward (claim) or < amount (withdraw) | `getReward`, `withdraw` | fund first |

## Functions

### Classification

- **User:** `getReward`
- **Financial:** `getReward` (pays out), `fund` (accepts), `withdraw` (recovers), `receive`
- **Administrative:** `setRewardAmount`, `pause`, `unpause`, `withdraw`
- **View:** `remainingClaims`, `fundedClaims`, `outstandingLiability`, `claimDigest`
- **Callback:** `receive()`

---

### getReward

```solidity
function getReward(uint256 deadline, bytes calldata signature)
    external nonReentrant whenNotPaused;
```

**Purpose:** Claim this address's share of the airdrop.

| Parameter | Type | Description |
| --- | --- | --- |
| `deadline` | `uint256` | Unix seconds after which the signature expires |
| `signature` | `bytes` | EIP-712 signature by a SIGNER_ROLE key over `Claim(msg.sender, deadline)` |

Returns nothing. external / nonpayable. **Access:** anyone with a valid signer signature;
`account` is always `msg.sender` (cannot claim for others).

**Execution flow:**
1. `account = _msgSender()`.
2. `block.timestamp > deadline` → revert `SignatureExpired`.
3. `hasClaimed[account]` → revert `AlreadyClaimed`.
4. `totalClaims >= maxClaims` → revert `AirdropFull`.
5. digest = `_hashTypedDataV4(keccak256(abi.encode(CLAIM_TYPEHASH, account, deadline)))`.
6. `ECDSA.tryRecover(digest, signature)`; if error ≠ NoError or recovered lacks
   `SIGNER_ROLE` → revert `InvalidSignature`.
7. Read `amount = rewardAmount`; balance check → else `InsufficientBalance`.
8. **Effects first:** `hasClaimed[account] = true`; `claimNumber = ++totalClaims`;
   emit `RewardClaimed`.
9. **Interaction:** `Address.sendValue(payable(account), amount)` (forwards 100% gas,
   no gas stipend issues).

**State changes:** `hasClaimed`, `totalClaims`, contract ETH balance.
**Events:** `RewardClaimed`. **Errors:** see table above.

**Security:**
- *Reentrancy:* CEI ordering + `nonReentrant` double protection; claim flag set before send.
- *Signature replay:* bound to contract+chain via EIP-712 domain; `deadline` bounds lifetime;
  one-shot per account anyway.
- *Malleability:* `tryRecover` rejects high-s values (OZ ECDSA).
- *Centralization:* SIGNER_ROLE can choose who gets slots; PAUSER can halt.

---

### remainingClaims / fundedClaims / outstandingLiability

```solidity
function remainingClaims() external view returns (uint256);      // maxClaims - totalClaims
function fundedClaims() external view returns (uint256);         // balance / rewardAmount
function outstandingLiability() external view returns (uint256); // remaining * rewardAmount
```

Pure read dashboards. Anyone. Note `fundedClaims()` floors; compare with
`outstandingLiability()` to detect underfunding. Revert risk: division by zero only if
`rewardAmount == 0`, impossible after construction + validation.

---

### claimDigest

```solidity
function claimDigest(address account, uint256 deadline) external view returns (bytes32);
```

Returns exactly the EIP-712 digest a backend must sign for `account`/`deadline`.
Useful for backends/tests to avoid duplicating domain logic.

---

### setRewardAmount

```solidity
function setRewardAmount(uint256 newAmount) external; // DEFAULT_ADMIN_ROLE
```

Changes per-claim reward for **future** claims only (already-claimed addresses unaffected).
Emits `RewardAmountUpdated(previous, new)` **before** writing state. Reverts `ZeroAmount`.

---

### pause / unpause

```solidity
function pause() external;   // PAUSER_ROLE
function unpause() external; // PAUSER_ROLE
```

Halt/resume `getReward` via `Pausable`. Emits `Paused`/`Unpaused`.

---

### fund / receive

```solidity
function fund() external payable;          // reverts ZeroAmount on 0
receive() external payable;                // accepts plain transfers
```

Both credit the pool and emit `Funded(sender, msg.value)`. Anyone.

---

### withdraw

```solidity
function withdraw(address to, uint256 amount) external; // DEFAULT_ADMIN_ROLE
```

Sends `amount` native to `to` via `Address.sendValue`. Checks: `to != 0`, `amount != 0`,
balance sufficient. Emits `Withdrawn` **before** the send (CEI; nonReentrant).

**Security:** admin can drain the pool including unclaimed rewards — intended recovery
path, but a compromised admin key steals the pool.

## Access Control

| Function | Required role | Who |
| --- | --- | --- |
| `getReward` | valid SIGNER_ROLE signature | Any eligible address |
| `fund`, `receive` | none | Anyone |
| `setRewardAmount` | `DEFAULT_ADMIN_ROLE` | Admin |
| `pause`/`unpause` | `PAUSER_ROLE` | Pauser |
| `withdraw` | `DEFAULT_ADMIN_ROLE` | Admin |

**CRITICAL ADMIN POWERS:** `withdraw` (drain pool), `setRewardAmount` (repricing),
`pause` (halt). SIGNER_ROLE decides eligibility — steal it and sign unlimited claims up
to the cap. Keep it off the deployer machine.

## Token / Financial Flow

```text
Treasury ──fund()/transfer──▶ Airdrop balance
                                  │
User ──getReward(deadline,sig)────┤
   ▲                              │ checks: paused? claimed? cap? sig?
   └── Address.sendValue(reward) ◀┘
Leftover: DEFAULT_ADMIN ──withdraw──▶ arbitrary recipient
```

No approvals needed (native coin). Refunds: none automatic — excess sits until withdrawn.

## Security Analysis

| Area | Verdict |
| --- | --- |
| Reentrancy | **No issue detected** — CEI + `nonReentrant` + `sendValue` (no gas-limited callback) |
| Signature replay across chains/deployments | **No issue** — EIP-712 domain binds chainId+address |
| Signature malleability / s-value | **No issue** — `ECDSA.tryRecover` enforces canonical s |
| Cap bypass | **Design consideration** — cap immutable; but `setRewardAmount` lets admin shrink reward to stretch the pool (not inflate past cap) |
| Centralization | **Potential risk** — SIGNER/PAUSER/ADMIN keys are single EOAs unless moved to multisig |
| DoS | Claimant's own gas only; no loops over users |
| Front-running | Claiming is not harmfully frontrunnable (per-address uniqueness) |

## Deployment Information

- Network: Nurachain (1020). Address: Not found in repository (recorded at deploy time only).
- Deploy: `npm run deploy:nurachain:airdrop` (`ignition/modules/airdrop.ts`), which asks for
  `--max-claims` / `--reward` (both immutable-at-construction or money-shaped; no defaults).
- Constructor gas preflighted by `scripts/preflight.ts`.

## Integration Guide

Backend flow:
1. Compute `digest = await airdrop.claimDigest(userAddress, deadline)`.
2. Sign with the SIGNER_ROLE key (`signer.signMessage` will NOT work — it is EIP-712 typed
   data, use `ethers.Signer.signTypedData` with domain `Airdrop v1`).
3. Send user `{ deadline, signature }`; user calls `getReward`.

Listen for: `RewardClaimed` (progress), `Fund`/`Withdrawn` (treasury ops),
`RewardAmountUpdated` (repricing). Failure cases: expired deadline (refetch+resign),
`AlreadyClaimed`, `AirdropFull`, underfunded pool.

## Function Reference

| Function | Visibility | Mutability | Access | Purpose |
| --- | --- | --- | --- | --- |
| `getReward(deadline,sig)` | external | nonpayable | Valid signer sig | Claim once |
| `remainingClaims()` | external | view | Anyone | Claims left under cap |
| `fundedClaims()` | external | view | Anyone | Claims payable now |
| `outstandingLiability()` | external | view | Anyone | Wei owed if all remaining claim |
| `claimDigest(account,deadline)` | external | view | Anyone | Exact EIP-712 digest |
| `setRewardAmount(new)` | external | nonpayable | DEFAULT_ADMIN | Reprice future claims |
| `pause()/unpause()` | external | nonpayable | PAUSER_ROLE | Halt/resume claims |
| `fund()` | external | payable | Anyone | Add to pool |
| `withdraw(to,amount)` | external | nonpayable | DEFAULT_ADMIN | Recover coin |
| `receive()` | external | payable | Anyone | Accept top-ups |
