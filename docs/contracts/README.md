# Smart Contract System — Overview

> **Languages / زبان‌ها / اللغات / Idiomas / Línguas / भाषाएँ / 语言 / Языки / Langues / Diller:**
> English (this folder, full reference) ·
> [فارسی](../fa/contracts/README.md) (full mirror) ·
> [العربية](../ar/contracts/README.md) ·
> [Español](../es/contracts/README.md) ·
> [Português](../pt/contracts/README.md) ·
> [हिन्दी](../hi/contracts/README.md) ·
> [中文](../zh/contracts/README.md) ·
> [Русский](../ru/contracts/README.md) ·
> [Français](../fr/contracts/README.md) ·
> [Türkçe](../tr/contracts/README.md)
>
> The English folder is the canonical, per-contract deep reference. `docs/fa/` mirrors it
> file-for-file; every other language ships a translated system overview pointing back here.

Documentation for every contract in this repository, generated from the actual source
under `contracts/`. One file per concrete first-party contract; libraries, mocks and
vendored code are covered by dedicated files as noted below.

## Contract Index

| Document | Contract | File | Kind |
| --- | --- | --- | --- |
| [BridgeToken.md](BridgeToken.md) | `BridgeToken` | `contracts/token/BridgeToken.sol` | abstract ERC20 base |
| [BridgeUSDT.md](BridgeUSDT.md) | `BridgeUSDT` | `contracts/token/BridgeUSDT.sol` | ERC20 token |
| [BridgeBNB.md](BridgeBNB.md) | `BridgeBNB` | `contracts/token/BridgeBNB.sol` | ERC20 token |
| [Airdrop.md](Airdrop.md) | `Airdrop` | `contracts/airdrop/Airdrop.sol` | native-coin airdrop |
| [CollateralizedNFT.md](CollateralizedNFT.md) | `CollateralizedNFT` | `contracts/vault/CollateralizedNFT.sol` | ERC721 vault |
| [PredictionFactory.md](PredictionFactory.md) | `PredictionFactory` | `contracts/forecast/PredictionFactory.sol` | clone factory + registry |
| [PredictionMarket.md](PredictionMarket.md) | `PredictionMarket` | `contracts/forecast/PredictionMarket.sol` | CPMM market (ERC-1155) |
| [PredictionPool.md](PredictionPool.md) | `PredictionPool` | `contracts/forecast/PredictionPool.sol` | parimutuel market |
| [PredictionTreasury.md](PredictionTreasury.md) | `PredictionTreasury` | `contracts/forecast/PredictionTreasury.sol` | fee sink |
| [FeeMath.md](FeeMath.md) | `FeeMath` | `contracts/forecast/libraries/FeeMath.sol` | library |
| [MarketMath.md](MarketMath.md) | `MarketMath` | `contracts/forecast/libraries/MarketMath.sol` | library |
| [WNURA.md](WNURA.md) | `WNURA` | `contracts/testing/WNURA.sol` | wrapped-native token |
| [MockToken.md](MockToken.md) | `MockToken` | `contracts/testing/MockToken.sol` | dev/test token |
| [TestAndVendoredContracts.md](TestAndVendoredContracts.md) | mocks + Uniswap V3 tree | various | test-only / vendored |

Interfaces (`IPredictionFactory`, `IPredictionMarket`, `IPredictionPool`,
`IPredictionTreasury`, `IBackingToken`) are documented within their implementing
contracts' *Interfaces* sections. Shared types: `PredictionTypes.sol`
(`MarketKind`, `MarketStatus`, `MarketParams`, `MarketRecord`),
`PredictionErrors.sol` (file-level custom errors), `PredictionEvents.sol`
(file-level events — one declaration site keeps topics identical across contracts).

## Core Architecture

```text
                        ┌──────────────────────────────────────────────┐
                        │                Nurachain 1020                │
                        └──────────────────────────────────────────────┘

 Bridge group                    Forecast group                     Vault group
 ────────────                    ──────────────                     ───────────
 relayer(minter/burner)          ADMIN_ROLE                         admin/minters
      │                               │                                  │
 BridgeUSDT/BridgeBNB        PredictionFactory ──createMarket──▶ CollateralizedNFT
      ▲                            │        └─createMarket2▶ EIP-1167 clone   ▲
      │ mint/adminBurn             │ create EIP-1167 clones     │             │ deposit/
      │                       PredictionMarket  PredictionPool  │             │ redeem
 users ◀──────── Transfer ────────────│──────────────────│──────────┘             │
                                      ▼                  ▼                        │
                              CPMM trading/bets    betting/claims                  │
                                      │ protocol/house fee                 backing ERC20
                                      ▼                                          │
                                PredictionTreasury ──withdraw──▶ feeRecipient ◀──┘
```

### The two prediction engines

Both are registered in one factory registry, share status buckets, treasury plumbing and
the event surface, and differ only in engine:

| | `createMarket` → PredictionMarket | `createMarket2` → PredictionPool |
| --- | --- | --- |
| Model | CPMM AMM over virtual reserves | Parimutuel pool |
| Instruments | ERC-1155 outcome shares + LP shares | plain stake accounting |
| Seed liquidity | required (payable creation) | none (creation reverts on value) |
| Early resolution | possible **before** lockTime (trust assumption) | impossible — `LockNotReached` |
| Fees | feeBps split protocol/LP per trade | one house fee off the whole pool at resolve |

## Dependency Graph

```text
PredictionFactory
├── Clones (OZ)
├── AccessControl (OZ)
├── PredictionMarket (implementation, cloned)
│   ├── ERC1155Supply/Initializable (OZ upgradeable)
│   ├── MarketMath, FeeMath
│   ├── IPredictionTreasury ──▶ PredictionTreasury
│   └── PredictionTypes/Events/Errors
└── PredictionPool (implementation, cloned)
    ├── Initializable (OZ upgradeable)
    ├── FeeMath
    ├── IPredictionTreasury ──▶ PredictionTreasury
    └── PredictionTypes/Events/Errors

BridgeUSDT / BridgeBNB ──▶ BridgeToken ──▶ OZ ERC20 stack (Burnable/Pausable/Permit/AccessControl)

CollateralizedNFT ──▶ OZ ERC721 + AccessControl + ReentrancyGuard + SafeERC20 ──▶ external IERC20

Airdrop ──▶ OZ AccessControl + Pausable + ReentrancyGuard + EIP712 + ECDSA

WNURA (standalone Dapphub WETH9 lineage), MockToken ──▶ OZ ERC20 (tests)
```

## Permission Model (system-wide)

| Contract | Roles / keys | Critical powers |
| --- | --- | --- |
| Bridge tokens | `DEFAULT_ADMIN_ROLE`, `MINTER_ROLE`, `BURNER_ROLE`, `PAUSER_ROLE` | unbacked mint, confiscating burn, global pause, rescue sweep |
| Airdrop | `DEFAULT_ADMIN_ROLE`, `PAUSER_ROLE`, `SIGNER_ROLE` | drain (`withdraw`), reprice, halt; signer decides eligibility |
| Vault | `DEFAULT_ADMIN_ROLE`, `MINTER_ROLE`; public-mint switch | future lock size, open free-mint race, withdraw **unreserved** tail only |
| Forecast factory | `ADMIN_ROLE` (+ DEFAULT admin of roles) | create markets (fees ≤ 10%), resolve/void every market, re-point treasuries |
| Markets | trust their `controller` (the factory) | lifecycle only reachable through the factory relay |
| Treasury | `Ownable2Step` owner | withdraw all fees, change recipient (two-step ownership) |

Deployment wiring: each Ignition module (`ignition/modules/{token,airdrop,vault,
forecast,univ3}.ts`) grants its admin role(s) to the deployer by default — move them to
a multisig before real value flows.

## Main User Flows

```text
Trade a CPMM market:
  user ──buy{value}(i,minOut,deadline)──▶ PredictionMarket ──cut──▶ Treasury
  user holds ERC-1155 id i ... after MarketResolved(w): redeem() pays winners 1:1

Bet a pool market:
  user ──bet{value}(i)──▶ PredictionPool (until lockTime)
  admin resolves after lock ─▶ winners claim() pro-rata net of house fee

Bridge in/out:
  relayer mints on inbound proof ──▶ user; BURNER burns on exit

Vault:
  funder deposits ERC20 ──▶ minter mints NFT (reserves lockAmount) ──▶ owner redeems (payout)

Airdrop:
  backend signs Claim(account,deadline) ──▶ user getReward() ──▶ native payout
```

## Main Admin Flows

- Deploy groups via `npx hardhat deploy --sc <group> --network nurachain`.
- Create markets: `createMarket{value}` / `createMarket2`; drive lifecycle via
  `pauseMarket/unpauseMarket/closeMarket/resolveMarket/voidMarket`.
- Fee policy: factory `setDefaultFees` (defaults for `feeBps=0` requests),
  treasury `setFeeRecipient`/`withdraw`.
- Recovery paths: `rescueERC20` (tokens), `withdrawExcessTokens` (vault tail),
  airdrop/treasury `withdraw`.

## Deployment Information (recorded in repository)

| Contract | Network | Address |
| --- | --- | --- |
| BridgeUSDT | Nurachain 1020 | `0x4E0DB0B1Da408faF5637202CF48b0bc7733bE6dC` |
| BridgeBNB | Nurachain 1020 | `0xD4221Ad9772BF5bA7423a044bBBEe6af2154A5Fc` |
| WNURA | Nurachain 1020 | `0xf0a4eC07916feBa4432121Ed5969887D9b939cD0` |
| Multicall3 *(chain infra)* | Nurachain 1020 | `0xf58884FCf45d8F5Cc8A73c618D23EB27b732CA24` |
| everything else | Nurachain 1020 | Not found in repository — recorded at deploy time only |

## Cross-Cutting Security Posture

- No proxy upgrades anywhere; all behaviour is fixed at deployment (vault README calls
  this out as deliberate for CollateralizedNFT).
- Clone implementations `_disableInitializers()`; clones initialize atomically at
  creation (no takeover window).
- Money paths use checks-effects-interactions plus storage-based reentrancy locks.
- Rounding always favours pools/treasury (floors payouts, ceils required inputs).
- Centralization is the standing risk: resolution, minting, pausing and draining all
  reduce to admin keys. See each contract's *Security Analysis* section.

## Verification Record

Scanned: all `.sol` under `contracts/` (first-party + testing + vendored univ3),
interfaces, libraries, mocks, Ignition modules, Hardhat config, tests, ABI extracts.
First-party concrete contracts/interfaces/libraries/mocks: **all documented above**;
vendored Uniswap V3 is documented at group level with provenance pointers
(see [TestAndVendoredContracts.md](TestAndVendoredContracts.md)).

```text
Documentation completed.

Contracts discovered:            14 first-party concrete/library/mock groups
                                 (+ vendored Uniswap V3 tree, group-level doc)
Contracts documented:            14
Functions discovered/documented: all public/external/internal functions of the
                                 14 first-party units are covered by their files
Events documented:               18 shared/file-level events + inherited standards
Errors documented:               17 shared errors + per-contract errors
Modifiers documented:            onlyController, nonReentrant, onlyController-only
                                 lifecycle guards, onlyRole/onlyOwner/whenNotPaused
Interfaces documented:           IPredictionFactory, IPredictionMarket,
                                 IPredictionPool, IPredictionTreasury, IBackingToken

Missing documentation:           0
```
