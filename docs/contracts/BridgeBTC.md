# BridgeBTC

## Contract Overview

| Property | Value |
| --- | --- |
| Contract name | `BridgeBTC` |
| Solidity file | `contracts/token/BridgeBTC.sol` |
| Solidity version | `^0.8.28` (solc 0.8.28, cancun) |
| Contract type | Concrete ERC20 token |
| Purpose | Bridged representation of BTC on Nurachain |
| Upgradeable / Proxy | No / No |
| Inherits | [`BridgeToken`](BridgeToken.md) |

Thin concrete wrapper: fixes name `"Bridge BTC"`, symbol `"BTC"`, **18 decimals** (matching
BTCB on BNB Chain; native Bitcoin and WBTC use 8, so a relayer bridging from
them scales amounts by `1e10`), delegating all behaviour to [`BridgeToken`](BridgeToken.md).

```solidity
constructor(address admin) BridgeToken("Bridge BTC", "BTC", 18, admin) {}
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

ABI: the `abi` array of `artifacts/contracts/token/BridgeBTC.sol/BridgeBTC.json`.
