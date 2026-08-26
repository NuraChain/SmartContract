# BridgeUSDT

## Contract Overview

| Property | Value |
| --- | --- |
| Contract name | `BridgeUSDT` |
| Solidity file | `contracts/token/BridgeUSDT.sol` |
| Solidity version | `^0.8.28` (solc 0.8.28, cancun) |
| Contract type | Concrete ERC20 token |
| Purpose | Bridged representation of USDT on Nurachain |
| Upgradeable / Proxy | No / No |
| Inherits | [`BridgeToken`](BridgeToken.md) |

Thin concrete wrapper: fixes name `"Bridge USDT"`, symbol `"USDT"`, **18 decimals**, and
hands the deployer-supplied `admin` to the `BridgeToken` constructor which grants it all
four roles. All behaviour is documented in [BridgeToken](BridgeToken.md).

```solidity
constructor(address admin) BridgeToken("Bridge USDT", "USDT", 18, admin) {}
```

## Decimals Note (economic significance)

18 decimals matches USDT on **BNB Chain**. USDT on Ethereum/Tron uses 6 decimals; a relayer
bridging from those chains MUST scale amounts by `1e12` before minting here, or minters will
create 10¹²× over-credited supply.

## State Variables / Constants

None of its own; everything inherited from `BridgeToken`
(`MINTER_ROLE`, `BURNER_ROLE`, `PAUSER_ROLE`, immutable `_tokenDecimals = 18`).

## Functions

No functions beyond constructors. Full API = [`BridgeToken`](BridgeToken.md) + OpenZeppelin
ERC20 surface (`name`, `symbol`, `totalSupply`, `balanceOf`, `transfer`, `allowance`,
`approve`, `transferFrom`, `burn`, `burnFrom`, `permit`, `decimals`, role admin functions).

| Function | Visibility | Mutability | Access | Purpose |
| --- | --- | --- | --- | --- |
| constructor(admin) | public | — | — | Grants DEFAULT_ADMIN/MINTER/BURNER/PAUSER to `admin` |

## Deployment Information

- Network: Nurachain, chain ID 1020
- Address: `0x4E0DB0B1Da408faF5637202CF48b0bc7733bE6dC` (recorded in
  `web/application/src/config/contracts.ts`)
- Deployment script: `ignition/modules/token.ts` (`npm run deploy:nurachain:token`)
- Deployment block / tx: Not found in repository

## Integration

ABI at `web/application/src/config/abi/BridgeUSDT.json`. See [BridgeToken](BridgeToken.md)
for flows and events.
