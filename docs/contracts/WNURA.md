# WNURA

## Contract Overview

| Property | Value |
| --- | --- |
| Contract name | `WNURA` |
| Solidity file | `contracts/testing/WNURA.sol` |
| Solidity version | `=0.6.6` (pinned; compiled with solc 0.6.6, istanbul) |
| Contract type | Concrete ERC20-compatible wrapped-native-coin contract |
| Purpose | Wrapped NURA: deposit native coin to mint `WNURA`, withdraw to unwrap. Needed by the Uniswap V3 periphery (routers trade an ERC20, not native value) and used as a test fixture |
| License | GPL-3.0 (Dapphub WETH9 lineage, renamed) |

Upstream ships this as WETH9 (BNB forks rename it WBNB); here it is renamed so wallets
show "WNURA". The on-chain canonical deployment **predates** this file's move to
`contracts/testing/` and is unaffected. Note: unlike stock WETH9, the payable fallback is
commented out in this copy — wrapping requires an explicit `deposit()` call.

## Inheritance / Interfaces

Standalone contract implementing the WETH9 surface (not derived from OZ ERC20).

## State Variables

| Variable | Type | Visibility | Purpose |
| --- | --- | --- | --- |
| `name` | `string` | public | `"Wrapped NURA"` |
| `symbol` | `string` | public | `"WNURA"` |
| `decimals` | `uint8` | public | `18` |
| `balanceOf` | `mapping(address => uint256)` | public | Key: holder → wrapped balance |
| `allowance` | `mapping(address => mapping(address => uint256))` | public | Keys: owner → spender → allowance |

## Events

Standard trio: `Deposit(dst, wad)` (indexed dst), `Withdrawal(src, wad)` (indexed src),
plus ERC20 `Transfer(src,dst,wad)` / `Approval(src,guy,wad)` (both parties indexed).

## Functions

### deposit

```solidity
function deposit() public payable;
```

Mints `msg.value` to caller (`balanceOf += msg.value`), emits `Deposit`. Anyone.

### withdraw

```solidity
function withdraw(uint wad) public;
```

Burns `wad`, unwraps via `msg.sender.transfer(wad)` (2300-gas stipend — contracts with
heavier receive logic will fail here; documented in the V3 router tests). Reverts on
insufficient balance (empty revert string). Anyone over their own balance.

### totalSupply

`address(this).balance` — supply always equals wrapped native held.

### approve

Sets unlimited-style absolute allowance (`allowance[msg.sender][guy] = wad`), returns
true. Note: no race protection beyond the Dapphub convention — see security notes.

### transfer / transferFrom

Dapphub semantics: `transferFrom` treats an allowance of `uint(-1)` (max) as infinite and
does not decrement it; otherwise decrements. Balance checks revert with empty strings.
Both return bool.

## Security Analysis

- **Legacy patterns by design:** `.transfer` payouts, non-decrementing max allowance,
  empty revert strings, pre-0.8 arithmetic. This is faithful vendored WETH9 behaviour,
  kept for compatibility with deployed infrastructure and V3 test harnesses.
- **No issue detected** for its intended role (wrapped-native fixture / router sink);
  do not treat it as a modern OZ ERC20.

## Deployment Information

- Canonical Nurachain address: `0xf0a4eC07916feBa4432121Ed5969887D9b939cD0`
  (recorded in `web/application/src/config/contracts.ts`; consumed by
  `ignition/modules/univ3.ts` as the default `wnura` parameter).
- Local/test deployments: `ethers.deployContract("WNURA")`.

## Integration Guide

Wrap: `wnura.deposit{value: x}()`; unwrap: `withdraw(x)`; standard
`approve/transfer/transferFrom` for routing. Listen: `Deposit`, `Withdrawal`, `Transfer`.
