# CollateralizedNFT

## Contract Overview

| Property | Value |
| --- | --- |
| Contract name | `CollateralizedNFT` |
| Solidity file | `contracts/vault/CollateralizedNFT.sol` |
| Solidity version | `^0.8.28` (solc 0.8.28, cancun) |
| Contract type | Concrete ERC721 vault (constructor-deployed) |
| Purpose | Every NFT is a claim on a fixed amount of one ERC20 held by this contract: minting reserves collateral, redeeming burns the token and pays the owner |
| Upgradeable / Proxy | No / No — deliberate (the redemption rule cannot be rewritten under holders) |

Each token's locked amount is recorded **at mint time** and never changes;
`setLockAmount` only affects future mints. Solvency is enforced by construction via two
invariants:

1. `totalReserved == Σ lockedAmount[id]` over outstanding ids.
2. `totalReserved ≤ backingToken.balanceOf(this)` — mint is the only thing that raises
   `totalReserved` and it pre-checks the unreserved balance; only redemption (lowers both
   sides equally) and `withdrawExcessTokens` (bounded to unreserved) can move tokens out.

Deliberate omissions (each would be a way to take holders' collateral): no pausing of
`redeem`, no ERC721Burnable, no upgradeability, immutable `backingToken`.

## Inheritance

```text
CollateralizedNFT
├── ERC721           -- NFT core; _safeMint/_burn/_requireOwned, Approval/Transfer events
├── AccessControl    -- DEFAULT_ADMIN_ROLE, MINTER_ROLE
└── ReentrancyGuard  -- guards deposit/mint/redeem/withdraw/rescue entry points
```

Uses OpenZeppelin `SafeERC20` for all ERC20 calls (`using SafeERC20 for IERC20`).

## Interfaces

| Interface | Interaction |
| --- | --- |
| `IERC20` | The backing token: `balanceOf`, `safeTransferFrom` (deposit), `safeTransfer` (redeem / withdrawExcess / rescue). Always through `SafeERC20`. |
| `IERC721` / `IAccessControl` / `ERC165` | Implemented surfaces (`supportsInterface` resolves the ERC721×AccessControl conflict). |

Related: [`IBackingToken`](IBackingToken) (`contracts/vault/IBackingToken.sol`) — an
`IERC20Metadata` alias that exists so tooling gets an artifact for external tokens used by
`scripts/vault-setup.ts`; not consumed by the contract itself.

## State Variables

| Variable | Type | Visibility | Mutability | Purpose |
| --- | --- | --- | --- | --- |
| `MINTER_ROLE` | `bytes32` | public | constant | May `mint`/`mintBatch` while public mint is off. Note: a minter can self-enrich from *unreserved* balance (mint→redeem); reserve accounting protects only other holders' collateral. |
| `backingToken` | `IERC20` | public | **immutable** | The single ERC20 locked behind every NFT. Immutable so outstanding claims can never point at a token the contract stopped holding. |
| `lockAmount` | `uint256` | public | mutable | Reservation per NFT for **future** mints, in the backing token's decimals. |
| `totalReserved` | `uint256` | public | mutable | Sum of locks over outstanding ids. Never exceeds balance by construction. |
| `totalMinted` | `uint256` | public | mutable | Lifetime mints; doubles as id counter (ids are 1..totalMinted). |
| `totalRedeemed` | `uint256` | public | mutable | Lifetime redemptions. |
| `publicMintEnabled` | `bool` | public | mutable | When false only MINTER_ROLE may mint. **Off at deployment.** |
| `lockedAmount` | `mapping(uint256 => uint256)` | public | mutable | Key: tokenId → wei of backing token redeemable for that exact id. Zero for unknown/burned ids. |
| `_baseTokenURI` | `string` | private | mutable | Metadata prefix used by `_baseURI()`. |

## Structs / Enums

None.

## Constants & Immutables

| Name | Value | Significance |
| --- | --- | --- |
| `MINTER_ROLE` | `keccak256("MINTER_ROLE")` | Gate for privileged minting |
| `backingToken` | constructor arg | Economic anchor; immutable on purpose |

## Modifiers

| Modifier | Source | Used by | Effect |
| --- | --- | --- | --- |
| `onlyRole(DEFAULT_ADMIN_ROLE)` | AccessControl | `setLockAmount`, `setPublicMintEnabled`, `setBaseURI`, `withdrawExcessTokens`, `rescueERC20` | Admin-only setters/sweeps |
| `nonReentrant` | ReentrancyGuard | `deposit`, `mint`, `mintBatch`, `redeem`, `burn`, `withdrawExcessTokens`, `rescueERC20` | Blocks reentry around ERC20/ERC721 callbacks |

## Events

| Event | Parameters | Indexed | Trigger |
| --- | --- | --- | --- |
| `Deposited` | `from, amount, newBalance` | `from` | `deposit`; `amount` = balance actually gained (fee-on-transfer safe) |
| `NFTMinted` | `recipient, tokenId, lockedAmount` | `recipient`, `tokenId` | Each mint, with the amount permanently reserved for that id |
| `NFTRedeemed` | `owner, tokenId, returnedAmount` | `owner`, `tokenId` | Redemption payout |
| `LockAmountUpdated` | `previousAmount, newAmount` | none | `setLockAmount` |
| `PublicMintUpdated` | `enabled` | none | `setPublicMintEnabled` |
| `BaseURIUpdated` | `newBaseURI` | none | `setBaseURI` |
| `ExcessTokensWithdrawn` | `to, amount` | indexed `to` | Unreserved withdrawal |
| `TokensRescued` | `token, to, amount` | `token`, `to` | Foreign-token sweep |

Plus standard ERC721 `Transfer`, `Approval`, `ApprovalForAll`.

## Errors

| Error | Triggered when | Paths | Avoidance |
| --- | --- | --- | --- |
| `ZeroAddress()` | zero admin/backingToken in ctor; zero recipient; zero withdraw/rescue dest | ctor, mint(s), withdrawals | real addresses |
| `ZeroAmount()` | ctor lock 0; deposit 0; setLockAmount(0); withdraw amount 0 | listed paths | positive values |
| `ZeroQuantity()` | `mintBatch(recipient, 0)` | mintBatch | quantity ≥ 1 |
| `InsufficientBacking(available, required)` | unreserved balance cannot cover reservation / requested excess | `_reserve`, `withdrawExcessTokens` | deposit first / smaller amount |
| `NotTokenOwner(tokenId, owner, caller)` | redeem caller ≠ current owner | `redeem`, `burn` | call from owner account |
| `MintNotPermitted(caller)` | public mint off and caller lacks MINTER_ROLE | `mint`, `mintBatch` | get role or wait for public mint |
| `BackingTokenNotRescuable()` | `rescueERC20` called with the backing token | rescueERC20 | use `withdrawExcessTokens` instead |
| *(inherited)* `ERC721InvalidSender/Receiver`, `ERC721NonexistentToken` | bad mint hooks; unknown id | mint/redeem | valid recipients/ids |

## Functions

### Classification

- **User:** `deposit`, `mint`*, `mintBatch`* (*gated when public mint off), `redeem`,
  `burn`
- **Financial:** `deposit`, `redeem`/`burn` (payout), `withdrawExcessTokens`, `rescueERC20`
- **Administrative:** `setLockAmount`, `setPublicMintEnabled`, `setBaseURI`,
  `withdrawExcessTokens`, `rescueERC20`
- **View:** `tokenBalance`, `availableBacking`, `remainingMintCapacity`, `totalSupply`,
  `vaultState` (+ ERC721 getters)
- **Private internals:** `_requireCanMint`, `_reserve`, `_mintOne`, `_redeem`, `_baseURI`

---

### deposit

```solidity
function deposit(uint256 amount) external nonReentrant;
```

Pulls `amount` backing tokens from caller via `safeTransferFrom`. Measures
balance-before/after so fee-on-transfer tokens record what actually arrived.
Open to anyone (a plain transfer does the same minus the event). Emits
`Deposited(sender, received, newBalance)`. Requires prior approval.

---

### mint

```solidity
function mint(address recipient) external nonReentrant returns (uint256 tokenId);
```

**Access:** anyone if `publicMintEnabled`, else `MINTER_ROLE`.
Flow: `_requireCanMint` → recipient ≠ 0 → `_reserve(1)` (checks + books `lockAmount`) →
`_mintOne` assigns id `++totalMinted`, writes `lockedAmount[id]`, emits `NFTMinted`,
then `_safeMint` **last** (all effects before the receiver callback; reentry blocked).
Returns the new id.

---

### mintBatch

```solidity
function mintBatch(address recipient, uint256 quantity) external nonReentrant returns (uint256 firstTokenId);
```

Reserves `quantity × lockAmount` in one check (reverts atomically rather than minting a
partial prefix), then loops `_mintOne`. Ids run `firstTokenId .. +quantity-1`. Batch size
bounded only by block gas (no explicit cap).

---

### redeem / burn

```solidity
function redeem(uint256 tokenId) external nonReentrant;
function burn(uint256 tokenId)   external nonReentrant;  // alias
```

**Access:** current owner only — approvals/operators deliberately do NOT qualify (approval
is permission to move the NFT, not to cash it out). Payout goes to the owner; there is no
recipient argument so it cannot be redirected.

Flow (`_redeem`): `_requireOwned(tokenId)` → ownership equality check → read
`amount = lockedAmount[id]` → **effects first**: `delete lockedAmount[id]`,
`totalReserved -= amount`, `++totalRedeemed`, `_burn(tokenId)` → emit `NFTRedeemed` →
`backingToken.safeTransfer(owner, amount)`. Emits standard `Transfer(to=0x0)` too.

---

### Views

```solidity
tokenBalance()          // backingToken.balanceOf(this)
availableBacking()      // saturating balance - totalReserved (never reverts)
remainingMintCapacity() // availableBacking() / lockAmount
totalSupply()           // totalMinted - totalRedeemed  (NOT IERC721Enumerable; by design)
vaultState()            // (balance, reserved, available, minted, redeemed,
                        //  outstanding, currentLockAmount, mintCapacity)
```

Plus inherited ERC721: `balanceOf`, `ownerOf`, `name`, `symbol`, `tokenURI`
(baseURI + decimal id), `getApproved`, `isApprovedForAll`.

---

### Administrative

```solidity
setLockAmount(uint256 newAmount)        // DEFAULT_ADMIN; future mints only; emits LockAmountUpdated
setPublicMintEnabled(bool enabled)      // DEFAULT_ADMIN; see warning below
setBaseURI(string calldata newBaseURI)  // DEFAULT_ADMIN; metadata only
withdrawExcessTokens(address to, uint256 amount) // DEFAULT_ADMIN + nonReentrant;
    // bounded by availableBacking(): reserved collateral unreachable
rescueERC20(IERC20 token, address to, uint256 amount) // DEFAULT_ADMIN + nonReentrant;
    // reverts BackingTokenNotRescuable for the backing token itself
```

**Warning on `setPublicMintEnabled(true)`:** minting is free (backed from the reserve), so
public mint ⇒ anyone can mint+redeem and race for the whole unreserved reserve. Only sane
if eligibility is enforced elsewhere (e.g. a paid minter contract holding MINTER_ROLE).

## Access Control

| Function | Required role | Who |
| --- | --- | --- |
| `deposit` | none | Anyone with allowance |
| `mint`/`mintBatch` | none iff `publicMintEnabled`, else `MINTER_ROLE` | Public / minters |
| `redeem`/`burn` | token ownership | Current owner |
| `setLockAmount`, `setPublicMintEnabled`, `setBaseURI`, `withdrawExcessTokens`, `rescueERC20` | `DEFAULT_ADMIN_ROLE` | Admin |
| role admin | `DEFAULT_ADMIN_ROLE` | Admin |

**CRITICAL ADMIN POWERS:** `withdrawExcessTokens` (up to full unreserved balance),
`setPublicMintEnabled(true)` (opens the free-mint race), `rescueERC20` (foreign tokens).
Neither admin nor minter can reach collateral behind someone else's live NFT — that is
what invariant 1+2 guarantee.

## Token / Financial Flow

```text
Depositor ──approve──▶ CollateralizedNFT ──deposit──▶ reserve pool
Minter   ──mint(n)──▶ NFTs + totalReserved += n·lockAmount
Owner    ──redeem(id)─▶ burn NFT ──safeTransfer(lockedAmount[id])──▶ owner
Admin    ──withdrawExcessTokens──▶ ≤ unreserved tail only
```

## Security Analysis

| Area | Verdict |
| --- | --- |
| Reentrancy | **No issue detected** — CEI everywhere; `_safeMint` hook arrives after booking; `nonReentrant` backstop |
| Insolvency | **No issue detected** — invariants hold by construction (see overview) |
| Confiscation of live collateral | **No path** — redeem restricted to owner; burn-without-pay impossible (no ERC721Burnable); rescue blocks the backing token |
| Fee-on-transfer tokens | Handled: deposit measures deltas; other paths transfer exact booked amounts (FoT backing token would under-deliver on redeem — use a plain ERC20 as backing) |
| Rebasing backing tokens | **Potential risk** — a negative rebasing token could shrink balance below `totalReserved`; `availableBacking` saturates and redemptions queue on remaining balance (first-come-first-served) |
| Centralization | **Design consideration** — admin controls future lock size, mint gating, and the unreserved tail |
| DoS | None beyond gas; batch bounded by block gas limit |

## Deployment Information

- Network: Nurachain (1020). Address: Not found in repository (recorded at deploy time).
- Deploy: `ignition/modules/vault.ts` (`npm run deploy:nurachain:vault -- --parameters ...`),
  requires the backing-token address parameter; funding flow via
  `npm run setup:nurachain:vault` (`scripts/vault-setup.ts`).

## Integration Guide

Reads: `vaultState()` for dashboards; `remainingMintCapacity()` before batching mints.
User flow: `token.approve(vault, n)` → `vault.mint(user)` → later `vault.redeem(id)`.
Listen: `NFTMinted`, `NFTRedeemed`, `Deposited`, `ExcessTokensWithdrawn`.
Common failures: `InsufficientBacking` (underfunded), `MintNotPermitted` (public mint off),
`NotTokenOwner` (non-owner redeem attempt).

```ts
const vault = await ethers.getContractAt("CollateralizedNFT", VAULT);
await (await usdt.approve(vault, amt)).wait();
await vault.mint(signer.address);
await vault.redeem(1n);
```

## Function Reference

| Function | Visibility | Mutability | Access | Purpose |
| --- | --- | --- | --- | --- |
| `deposit(amount)` | external | nonpayable | Anyone | Add backing tokens |
| `mint(recipient)` | external | nonpayable | Role/public | Mint one backed NFT |
| `mintBatch(recipient,q)` | external | nonpayable | Role/public | Mint q backed NFTs |
| `redeem(tokenId)` | external | nonpayable | Owner | Burn + payout |
| `burn(tokenId)` | external | nonpayable | Owner | Alias of redeem |
| `tokenBalance()` | public | view | Anyone | Total backing held |
| `availableBacking()` | public | view | Anyone | Unreserved backing |
| `remainingMintCapacity()` | public | view | Anyone | Affordable mints |
| `totalSupply()` | external | view | Anyone | Outstanding NFTs |
| `vaultState()` | external | view | Anyone | Full accounting snapshot |
| `setLockAmount(new)` | external | nonpayable | DEFAULT_ADMIN | Future mint rate |
| `setPublicMintEnabled(b)` | external | nonpayable | DEFAULT_ADMIN | Mint gate |
| `setBaseURI(uri)` | external | nonpayable | DEFAULT_ADMIN | Metadata |
| `withdrawExcessTokens(to,amt)` | external | nonpayable | DEFAULT_ADMIN | Withdraw unreserved |
| `rescueERC20(t,to,amt)` | external | nonpayable | DEFAULT_ADMIN | Sweep foreign token |
| `supportsInterface(id)` | public | view | Anyone | ERC-165 |
