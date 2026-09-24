# BridgeETH

## Contract Overview

| Property | Value |
| --- | --- |
| Contract name | `BridgeETH` |
| Solidity file | `contracts/token/BridgeETH.sol` |
| Solidity version | `^0.8.28` (solc 0.8.28, cancun) |
| Contract type | Concrete ERC20 token |
| Purpose | Bridged representation of ETH on Nurachain |
| Upgradeable / Proxy | No / No |
| Inherits | [`BridgeToken`](BridgeToken.md) |

Thin concrete wrapper: fixes name `"Bridge ETH"`, symbol `"ETH"`, **18 decimals** (matching
native ETH), delegating all behaviour to [`BridgeToken`](BridgeToken.md).

```solidity
constructor(address admin) BridgeToken("Bridge ETH", "ETH", 18, admin) {}
```

## Functions

No additional functions. Full API = [`BridgeToken`](BridgeToken.md) + standard ERC20 surface.

| Function | Visibility | Mutability | Access | Purpose |
| --- | --- | --- | --- | --- |
| constructor(admin) | public | — | — | Grants DEFAULT_ADMIN/MINTER/BURNER/PAUSER to `admin` |

## Deployment Information

- Network: Nurachain, chain ID 1020
- Address: not deployed yet
- Deployment script: `ignition/modules/token.ts`
- Deployment block / tx: Not found in repository

## Integration

ABI: the `abi` array of `artifacts/contracts/token/BridgeETH.sol/BridgeETH.json`.
