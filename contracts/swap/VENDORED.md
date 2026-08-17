# Vendored sources

The AMM is the canonical UniswapV2, vendored verbatim from the published npm
tarballs with package imports rewritten to relative paths. The math is untouched.

| Path | Source | Version | License |
| --- | --- | --- | --- |
| contracts/core/** | @uniswap/v2-core | 1.0.1 | GPL-3.0 |
| contracts/periphery/** (except below) | @uniswap/v2-periphery | 1.1.0-beta.0 | GPL-3.0 |
| contracts/periphery/libraries/TransferHelper.sol | @uniswap/lib | 4.0.1-alpha | GPL-3.0-or-later |
| contracts/periphery/WBNB.sol | @uniswap/v2-periphery contracts/test/WETH9.sol (Dapphub WETH9) | 1.1.0-beta.0 | GPL-3.0-or-later |
| contracts/vendor/Multicall3.sol | github.com/mds1/multicall3 | main | MIT |

Local modifications:

- Package imports (`@uniswap/v2-core/...`, `@uniswap/lib/...`) rewritten to relative paths.
- `WBNB.sol`: contract renamed WETH9 to WBNB, name/symbol strings changed to
  "Wrapped BNB"/"WBNB". No functional change.
- `periphery/libraries/UniswapV2Library.sol`: the hardcoded pair init code hash is
  regenerated from our compiled Pair bytecode by `scripts/write-init-code-hash.ts`.
  The optimizer settings and evmVersion in hardhat.config.ts are inputs to that
  hash - changing them requires rerunning the codegen.

Compiler pins: core =0.5.16, periphery =0.6.6, optimizer runs 999999,
evmVersion istanbul for both.
