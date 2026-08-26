# BridgeBNB

## Contract Overview

| Property | Value |
| --- | --- |
| Contract name | `BridgeBNB` |
| Solidity file | `contracts/token/BridgeBNB.sol` |
| Solidity version | `^0.8.28` (solc 0.8.28, cancun) |
| Contract type | Concrete ERC20 token |
| Purpose | Bridged representation of BNB on Nurachain |
| Upgradeable / Proxy | No / No |
| Inherits | [`BridgeToken`](BridgeToken.md) |

Thin concrete wrapper: fixes name `"Bridge BNB"`, symbol `"BNB"`, **18 decimals** (matching
native BNB), delegating all behaviour to [`BridgeToken`](BridgeToken.md).

```solidity
constructor(address admin) BridgeToken("Bridge BNB", "BNB", 18, admin) {}
```

## Functions

No additional functions. Full API = [`BridgeToken`](BridgeToken.md) + standard ERC20 surface.

| Function | Visibility | Mutability | Access | Purpose |
| --- | --- | --- | --- | --- |
| constructor(admin) | public | — | — | Grants DEFAULT_ADMIN/MINTER/BURNER/PAUSER to `admin` |

## Deployment Information

- Network: Nurachain, chain ID 1020
- Address: `0xD4221Ad9772BF5bA7423a044bBBEe6af2154A5Fc` (recorded in
  `web/application/src/config/contracts.ts`)
- Deployment script: `ignition/modules/token.ts`
- Deployment block / tx: Not found in repository

## Integration

ABI at `web/application/src/config/abi/BridgeBNB.json`.
