# Vendored sources

`contracts/univ3` is the canonical UniswapV3, vendored verbatim with package imports
rewritten to relative paths. The math is untouched.

| Path | Source | Version | License |
| --- | --- | --- | --- |
| `core/**` | [Uniswap/v3-core](https://github.com/Uniswap/v3-core) | `main` (identical to npm `@uniswap/v3-core` 1.0.1) | BUSL-1.1 / GPL-2.0-or-later |
| `periphery/**` | [Uniswap/v3-periphery](https://github.com/Uniswap/v3-periphery) | `main` (npm `@uniswap/v3-periphery` 1.4.4) | GPL-2.0-or-later |
| `vendor/openzeppelin/**` | @openzeppelin/contracts | 3.4.2 | MIT |
| `vendor/uniswap-lib/**` | @uniswap/lib | 4.0.1-alpha | GPL-3.0-or-later |
| `vendor/base64/base64.sol` | base64-sol | 1.0.1 | MIT |

96 files, resolved as the exact import closure of the seven contracts this repo deploys
(`UniswapV3Factory`, `UniswapV3Pool`, `SwapRouter`, `NonfungiblePositionManager`,
`NonfungibleTokenPositionDescriptor`, `QuoterV2`, `TickLens`) — not a whole-tree copy.

The concrete contracts had to come from GitHub rather than npm: `@uniswap/v3-core` and
`@uniswap/v3-periphery` publish only `interfaces/` and `libraries/` to npm, plus compiled
`artifacts/`. Every `.sol` file the two sources share is byte-identical, so the GitHub
tree is the same code the published artifacts were built from — and the init code hash
below proves it independently.

## Licensing

The ten `core/` files listed below carry `SPDX-License-Identifier: BUSL-1.1`:

```
core/UniswapV3Factory.sol      core/libraries/Oracle.sol
core/UniswapV3Pool.sol         core/libraries/Position.sol
core/UniswapV3PoolDeployer.sol core/libraries/SqrtPriceMath.sol
core/NoDelegateCall.sol        core/libraries/SwapMath.sol
                               core/libraries/Tick.sol
                               core/libraries/TickBitmap.sol
```

The Business Source License in [`LICENSE_BUSL`](LICENSE_BUSL) sets a **Change Date of
2023-04-01** and a Change License of **GPL-2.0-or-later**. That date has passed, so those
files are now available under GPL-2.0-or-later and production use is permitted. The
original BUSL text is kept because the SPDX headers still name it.

Everything else in `core/` and `periphery/` is GPL-2.0-or-later — see [`LICENSE`](LICENSE).
`vendor/openzeppelin` and `vendor/base64` are MIT; `vendor/uniswap-lib` is
GPL-3.0-or-later. All upstream copyright notices and SPDX headers are preserved verbatim.

Note this differs from `contracts/testing/WNURA.sol` (Dapphub's WETH9, renamed), which is
GPL-**3**.0. The two trees are under different licenses and each carries its own.

## Local modifications

- Package imports (`@uniswap/v3-core/...`, `@openzeppelin/...`, `@uniswap/lib/...`,
  `base64-sol/...`) rewritten to relative paths. 48 import statements, no other change.

- **`periphery/NonfungibleTokenPositionDescriptor.sol`**: added a `chainId == 1020` branch
  to `tokenRatioPriority`, giving Nurachain's bridged tokens the same treatment upstream
  gives Ethereum's:

  | Token | Address | Order |
  | --- | --- | --- |
  | `BridgeUSDT` | `0x4E0DB0B1Da408faF5637202CF48b0bc7733bE6dC` | `NUMERATOR_MOST` |
  | `BridgeBNB` | `0xD4221Ad9772BF5bA7423a044bBBEe6af2154A5Fc` | `DENOMINATOR_MORE` |

  Upstream only knows Ethereum's stablecoins, behind `if (chainId == 1)`. Without this
  every token on Nurachain scores 0 and the position NFT prints whichever address sorts
  lower as the numerator — "0.00003 USDT per NURA" instead of "34000 NURA per USDT". It
  is cosmetic: `tokenURI` is `view`, and nothing in the accounting reads it.

  The native currency label is **not** a source change — `nativeCurrencyLabelBytes` is a
  constructor argument, and `ignition/modules/univ3.ts` passes `bytes32("NURA")`.

- `periphery/libraries/PoolAddress.sol`: `POOL_INIT_CODE_HASH` is regenerated from our
  compiled `UniswapV3Pool` by `scripts/write-init-code-hash.ts`. It currently reads
  `0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54`, which is
  **byte-for-byte Uniswap's own published constant** — the same value that puts the real
  USDC/WETH 0.05% pool at `0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640` on Ethereum. That
  is not a coincidence to rely on but a check to keep: it only comes out equal because
  the compiler settings match upstream exactly. If it ever changes, the settings drifted.

Nothing else is modified. In particular `core/libraries/**` — `TickMath`, `SqrtPriceMath`,
`SwapMath`, `FullMath`, `BitMath`, `Tick`, `TickBitmap`, `Position`, `Oracle` — is
verbatim, and should stay that way. That code is where V3 forks go wrong.

## Compiler pins

All of `contracts/univ3` is solc **=0.7.6**, `evmVersion` **istanbul**, and
`metadata.bytecodeHash: "none"`, copied from upstream's own `hardhat.config.ts`. Optimizer
runs follow upstream per file:

| Runs | Files | From |
| --- | --- | --- |
| 800 | `core/**`, `vendor/**` | v3-core's config |
| 1000000 | `periphery/**` except below | v3-periphery `DEFAULT_COMPILER_SETTINGS` |
| 2000 | `periphery/NonfungiblePositionManager.sol` | v3-periphery `LOW_OPTIMIZER_COMPILER_SETTINGS` |
| 1000 | `periphery/NonfungibleTokenPositionDescriptor.sol`, `periphery/libraries/NFTDescriptor.sol` | v3-periphery `LOWEST_OPTIMIZER_COMPILER_SETTINGS` |

Two reasons these are not free choices, and the second is the hard one:

1. They are inputs to the pool init code hash, as above.
2. **Nurachain enforces EIP-170 at exactly 24576 bytes.** `UniswapV3Factory` compiles to
   24535 and `NFTDescriptor` to 24541 — 41 and 35 bytes of headroom. Dropping
   `bytecodeHash: "none"` alone costs about 40 bytes of metadata, which is enough to make
   the factory undeployable. `test/univ3/Build.test.ts` asserts every contract against the
   limit so this fails in `npm test` rather than on-chain.

Every file under `contracts/univ3` is pinned to 0.7.6 by name in `hardhat.config.ts`, because
only 19 of the 96 say `pragma solidity =0.7.6` — the rest are open ranges that 0.8.28 also
satisfies, and Hardhat resolves an open range to the newest compiler that fits.
