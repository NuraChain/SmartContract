# BridgeToken

## Contract Overview

| Property | Value |
| --- | --- |
| Contract name | `BridgeToken` |
| Solidity file | `contracts/token/BridgeToken.sol` |
| Solidity version | `^0.8.28` (compiled with solc 0.8.28, evmVersion `cancun`) |
| Contract type | `abstract contract` — shared base, never deployed directly |
| Purpose | Shared implementation for bridged (wrapped) ERC20 assets whose supply is minted on inbound bridge transfers and burned on outbound ones |
| Upgradeable | No |
| Proxy | No |
| License | MIT |

`BridgeToken` is an opinionated ERC20 base for bridge representations of external assets.
Supply is **not** backed by anything on-chain: a relayer holding `MINTER_ROLE` mints when it
observes a deposit on the source chain, and `BURNER_ROLE` burns when a holder exits back.
Every unit therefore depends entirely on the bridge operator honouring the 1:1 backing.

Two deliberate operator powers exist and are documented as such:

- `adminBurn()` destroys **any** holder's balance without an allowance.
- `pause()` freezes all transfers, mints and burns.

Concrete deployments: [`BridgeUSDT`](BridgeUSDT.md) and [`BridgeBNB`](BridgeBNB.md).

## Inheritance

```text
BridgeToken (abstract)
├── ERC20              -- standard token core: balances, approvals, Transfer/Approval events
├── ERC20Burnable      -- holder-initiated burn() / burnFrom() (allowance-based)
├── ERC20Pausable      -- hooks _update to revert all transfers while paused
├── AccessControl      -- role-based permissions (DEFAULT_ADMIN/MINTER/BURNER/PAUSER)
└── ERC20Permit        -- EIP-2612 gasless approvals via secp256k1 signatures
```

| Base | Why inherited |
| --- | --- |
| `ERC20` | Token core. `_update` is the single balance-mutation hook that every other base resolves through. |
| `ERC20Burnable` | Keeps standard holder-side `burn`/`burnFrom` alongside the admin-side `adminBurn`. Allowance-based, so holders keep normal ERC20 behaviour. |
| `ERC20Pausable` | Overrides `_update` to revert while paused; resolved against `ERC20._update` in `_update` below. |
| `AccessControl` | The four-role permission model. `onlyRole(...)` guards every administrative function. |
| `ERC20Permit` | EIP-2612 `permit()`; domain name equals the token name (`ERC20Permit(name_)`). |

## Interfaces

| Interface | Purpose / interaction |
| --- | --- |
| `IERC20` (OpenZeppelin) | Parameter type of `rescueERC20`; the swept token is moved via `SafeERC20.safeTransfer`. |
| `IERC20Permit` (implemented via `ERC20Permit`) | Standard EIP-2612 surface exposed to holders. |
| `IAccessControl` (implemented via `AccessControl`) | Role introspection used by frontends/tests (`hasRole`, `getRoleAdmin`, ...). |

## State Variables

| Variable | Type | Visibility | Mutability | Purpose |
| --- | --- | --- | --- | --- |
| `MINTER_ROLE` | `bytes32` | public | `constant` | Role id (`keccak256("MINTER_ROLE")`) required to call `mint`/`mintBatch`. |
| `BURNER_ROLE` | `bytes32` | public | `constant` | Role id required to call `adminBurn`. |
| `PAUSER_ROLE` | `bytes32` | public | `constant` | Role id required to call `pause`/`unpause`. |
| `_tokenDecimals` | `uint8` | private | `immutable` | Decimals fixed at construction; returned by the overridden `decimals()`. Should match the source-chain asset. |

Inherited storage of note: `AccessControl._roles` (mapping of role → role data incl. members),
`ERC20Permit._PERMIT_NONCES` (per-owner permit nonces), `ERC20Pausable._paused`
(via `Pausable`).

## Structs

None declared in this contract. (Inherited: `AccessControl.RoleData` — `{members: EnumerableSet.AddressSet, adminRole: bytes32}`.)

## Enums

None.

## Constants & Immutables

| Name | Type | Value | Purpose / significance |
| --- | --- | --- | --- |
| `MINTER_ROLE` | `bytes32` | `keccak256("MINTER_ROLE")` | Gates supply creation. A leaked minter key can mint unbacked supply. |
| `BURNER_ROLE` | `bytes32` | `keccak256("BURNER_ROLE")` | Gates unconditional burning of any account. |
| `PAUSER_ROLE` | `bytes32` | `keccak256("PAUSER_ROLE")` | Gates the global transfer freeze. |
| `_tokenDecimals` | `uint8` | constructor arg | Immutable decimals (18 for both concrete tokens). |

## Modifiers

| Modifier | From | Condition | Prevents | Used by |
| --- | --- | --- | --- | --- |
| `onlyRole(role)` | `AccessControl` | `hasRole(role, msg.sender)` | Unauthorized administrative calls | `mint`, `mintBatch`, `adminBurn`, `pause`, `unpause`, `rescueERC20` |
| `whenNotPaused` | `Pausable` | `!paused()` | Any transfer/mint/burn while frozen (applied inside `ERC20._update` and `ERC20Burnable.burn*`) | all token movements when paused |

## Events

| Event | Parameters | Indexed | Trigger |
| --- | --- | --- | --- |
| `BridgeMint` | `to, amount, operator` | `to`, `operator` | Every successful `mint` / per-recipient in `mintBatch` |
| `BridgeBurn` | `from, amount, operator` | `from`, `operator` | Successful `adminBurn` |
| `TokensRescued` | `token, to, amount` | `token`, `to` | Successful `rescueERC20` |

Also emits standard `Transfer` (mints/burns/transfers), `Approval`, EIP-2612 `Approval`
(domain `permit`), and `Paused`/`Unpaused`.

Indexers should treat `BridgeMint`/`BridgeBurn` as the bridge settlement ledger (they carry
the operator identity that plain `Transfer` lacks).

## Errors

| Error | Parameters | Trigger condition | Callable paths | Avoidance |
| --- | --- | --- | --- | --- |
| `ZeroAddress()` | — | Constructor `admin == 0`; `rescueERC20` with `to == 0` | constructor, `rescueERC20` | Pass real addresses |
| `ArrayLengthMismatch(recipients, amounts)` | two `uint256` lengths | `mintBatch` inputs differ in length | `mintBatch` | Align array lengths |
| `EmptyBatch()` | — | `mintBatch` with zero-length arrays | `mintBatch` | Supply ≥ 1 pair |
| *(inherited)* `EnforcedPause()` | — | any transfer/mint/burn while paused | all movement | Wait for `unpause` |
| *(inherited)* `ECDSA.InvalidSignatureS` etc. | — | malformed `permit` signature | `permit` | Sign correctly |

## Functions

### Classification

- **Administrative:** `mint`, `mintBatch`, `adminBurn`, `pause`, `unpause`, `rescueERC20`
- **Financial:** `mint`, `mintBatch`, `adminBurn`, `rescueERC20` (move tokens); `burn`, `burnFrom`, `transfer`, `transferFrom`, `permit` (inherited)
- **View:** `decimals` (overridden); inherited ERC20/Permit/AccessControl getters
- **Internal:** `_update`

---

### mint

```solidity
function mint(address to, uint256 amount) external;
```

**Purpose:** Creates `amount` tokens for `to`; the on-chain leg of an inbound bridge transfer.

| Parameter | Type | Description |
| --- | --- | --- |
| `to` | `address` | Recipient of the new supply |
| `amount` | `uint256` | Amount in token base units |

Returns nothing. **Visibility:** external · **Mutability:** nonpayable ·
**Access:** `MINTER_ROLE`.

**Preconditions:** not paused; `to != address(0)` (enforced by `_mint`).

**Execution flow:** 1. `onlyRole(MINTER_ROLE)` check. 2. `_mint(to, amount)` (updates
balances + totalSupply, emits `Transfer(0x0→to)`). 3. `emit BridgeMint(to, amount, msg.sender)`.

**State changes:** balances, `totalSupply`. **Events:** `Transfer`, `BridgeMint`.
**Errors:** `EnforcedPause` (paused). 

**Security:** Centralization — whoever holds MINTER_ROLE can create unbacked supply at
will. There is no on-chain proof that a corresponding source-chain deposit exists (no
replay protection keyed by source tx either — see repo README note).

---

### mintBatch

```solidity
function mintBatch(address[] calldata recipients, uint256[] calldata amounts) external;
```

**Purpose:** Settles many inbound transfers atomically.

| Parameter | Type | Description |
| --- | --- | --- |
| `recipients` | `address[]` | Recipients, one per transfer |
| `amounts` | `uint256[]` | Amounts, parallel to `recipients` |

Returns nothing. **Visibility/Mutability:** external / nonpayable. **Access:** `MINTER_ROLE`.

**Execution flow:** 1. length equality check → else `ArrayLengthMismatch`. 2. empty check →
else `EmptyBatch`. 3. loop: `_mint` + `BridgeMint` per element.

**State changes:** N × (balances, totalSupply). **Events:** N × (`Transfer`,`BridgeMint`).
**Errors:** `ArrayLengthMismatch`, `EmptyBatch`, `EnforcedPause`.

**Security:** Gas-bound loop; batch size is bounded only by block gas limit. All-or-nothing
(one bad item reverts the whole batch).

---

### adminBurn

```solidity
function adminBurn(address from, uint256 amount) external;
```

**Purpose:** Destroys `amount` from `from` for an outbound bridge transfer — **without**
requiring an allowance or holder signature.

| Parameter | Type | Description |
| --- | --- | --- |
| `from` | `address` | Account whose balance is destroyed |
| `amount` | `uint256` | Amount to destroy |

Returns nothing. external / nonpayable. **Access:** `BURNER_ROLE`.

**Execution flow:** `_burn(from, amount)` (emits `Transfer(from→0x0)`), then
`emit BridgeBurn(from, amount, msg.sender)`.

**State changes:** balances, `totalSupply`. **Events:** `Transfer`, `BridgeBurn`.
**Errors:** insufficient-balance panic (0x11) if `balanceOf(from) < amount`; `EnforcedPause`.

**Security:** CRITICAL power: can confiscate any holder's tokens. Deliberate but must sit
behind a multisig/timelock.

---

### pause / unpause

```solidity
function pause() external;   // PAUSER_ROLE
function unpause() external; // PAUSER_ROLE
```

Freeze/resume every transfer, mint and burn by toggling `Pausable._paused`.
Emits `Paused`/`Unpaused`. Revert `EnforcedPause`/`ExpectedPause` when misused.
**Security:** pausing freezes third-party funds; key compromise = freeze.

---

### rescueERC20

```solidity
function rescueERC20(IERC20 token, address to, uint256 amount) external;
```

**Purpose:** Sweeps tokens accidentally sent to the contract (including its own token).

| Parameter | Type | Description |
| --- | --- | --- |
| `token` | `IERC20` | Stranded token contract |
| `to` | `address` | Destination (non-zero) |
| `amount` | `uint256` | Quantity to sweep |

external / nonpayable. **Access:** `DEFAULT_ADMIN_ROLE`.

**Flow:** zero-address check → `SafeERC20.safeTransfer(token, to, amount)` →
`TokensRescued`. **Errors:** `ZeroAddress`; token-level revert bubbles.

**Security:** arbitrary-token sweep restricted to admin; cannot steal user allowances
(it only moves contract-held balances).

---

### decimals (overridden)

```solidity
function decimals() public view returns (uint8);
```

Returns `_tokenDecimals` instead of ERC20's default 18. public / view / anyone.

---

### _update (internal override)

```solidity
function _update(address from, address to, uint256 value) internal override(ERC20, ERC20Pausable);
```

Linearized hook so both the ERC20 bookkeeping and the pause gate run:
`super._update(from, to, value)` dispatches to `ERC20Pausable._update` which checks
`whenNotPaused` and forwards to `ERC20._update`. Called by every transfer/mint/burn path.

---

### Inherited public API (relevant)

`name`, `symbol`, `totalSupply`, `balanceOf`, `transfer`, `allowance`, `approve`,
`transferFrom`, `increaseAllowance`, `decreaseAllowance`, `burn`, `burnFrom`,
`permit`, `nonces`, `DOMAIN_SEPARATOR`, `paused`, `hasRole`, `getRoleAdmin`,
`grantRole`, `revokeRole`, `renounceRole`, `supportsInterface` — semantics are stock
OpenZeppelin 5.x; `grantRole/revokeRole` require the role's admin (DEFAULT_ADMIN_ROLE).

## Access Control

| Function | Required role | Who can execute |
| --- | --- | --- |
| `mint` / `mintBatch` | `MINTER_ROLE` | Bridge operator(s) |
| `adminBurn` | `BURNER_ROLE` | Bridge operator(s) |
| `pause` / `unpause` | `PAUSER_ROLE` | Operator security key |
| `rescueERC20` | `DEFAULT_ADMIN_ROLE` | Admin |
| `grantRole` / `revokeRole` | role's admin (`DEFAULT_ADMIN_ROLE`) | Admin |
| everything else | none | Anyone |

**CRITICAL ADMIN POWERS:** `mint*` (unbacked inflation), `adminBurn` (confiscation),
`pause` (global freeze), `rescueERC20` (sweep). At deployment all four roles go to the
single `admin` address — move them to a multisig before real value flows.

## Token / Financial Flow

```text
Source chain deposit observed off-chain
   ↓
MINTER_ROLE calls mint()/mintBatch()
   ↓
User receives bridged tokens (Transfer + BridgeMint)
   ↓ (exit)
User approves … or BURNER_ROLE acts directly
   ↓
adminBurn() destroys supply  →  relayer releases asset on source chain
```

Stray tokens in the contract: admin → `rescueERC20` → chosen recipient.

## Security Analysis

- **Confirmed by design (documented trust assumptions):** no on-chain backing proof; no
  mint replay protection; `adminBurn` confiscation; pausable transfers.
- **Reentrancy:** not applicable — no external calls except `SafeERC20` in rescue.
- **Overflow:** Solidity 0.8 checked arithmetic; OpenZeppelin 5.x audited core.
- **Permit:** standard OZ EIP-2612; nonce + domain `(name, version "1", chainId, this)`.
- **Centralization:** single admin holds all roles initially.

## Upgradeability

None. Abstract base; concrete tokens are plain constructors, immutable after deploy.

## Deployment Information

See [BridgeUSDT](BridgeUSDT.md) / [BridgeBNB](BridgeBNB.md). Deployed via
`ignition/modules/token.ts` (`npm run deploy:nurachain:token`). Chain: Nurachain (1020).

## Integration Guide

- ABI: `web/application/src/config/abi/BridgeUSDT.json` / `BridgeBNB.json`.
- Reads: `balanceOf`, `allowance`, `paused`, `decimals`, `nonces`, `DOMAIN_SEPARATOR`.
- Writes (users): `approve`, `transfer`, `permit`; (relayer): `mint`, `mintBatch`, `adminBurn`;
  (admin): `pause`, `rescueERC20`, role grants.
- Listen: `Transfer`, `BridgeMint`, `BridgeBurn`, `Paused`, `Unpaused`.
- Failure cases: `EnforcedPause` during incidents; permit replay → `ERC2612InvalidSigner`.

```ts
const usdt = await ethers.getContractAt("BridgeUSDT", USDT_ADDRESS);
await usdt.mint(user.address, ethers.parseUnits("100", 18));
```

## Function Reference

| Function | Visibility | Mutability | Access | Purpose |
| --- | --- | --- | --- | --- |
| `mint(to,amount)` | external | nonpayable | MINTER_ROLE | Mint on inbound transfer |
| `mintBatch(recipients,amounts)` | external | nonpayable | MINTER_ROLE | Batched mint |
| `adminBurn(from,amount)` | external | nonpayable | BURNER_ROLE | Burn any account, no allowance |
| `pause()` / `unpause()` | external | nonpayable | PAUSER_ROLE | Global freeze switch |
| `rescueERC20(token,to,amount)` | external | nonpayable | DEFAULT_ADMIN | Sweep stray tokens |
| `decimals()` | public | view | Anyone | Configured decimals |
| `burn(amount)` *(inherited)* | public | nonpayable | Holder | Self-burn |
| `burnFrom(from,amount)` *(inherited)* | public | nonpayable | Allowance | Allowance-based burn |
| `permit(...)` *(inherited)* | external | nonpayable | Signature holder | EIP-2612 approval |
| `supportsInterface(bytes4)` *(inherited)* | public | view | Anyone | ERC-165 |
