# Vendored sources

The AMM is the canonical UniswapV2, vendored verbatim from the published npm
tarballs with package imports rewritten to relative paths. The math is untouched.

| Path | Source | Version | License |
| --- | --- | --- | --- |
| contracts/core/** | @uniswap/v2-core | 1.0.1 | GPL-3.0 |
| contracts/periphery/** (except below) | @uniswap/v2-periphery | 1.1.0-beta.0 | GPL-3.0 |
| contracts/periphery/libraries/TransferHelper.sol | @uniswap/lib | 4.0.1-alpha | GPL-3.0-or-later |
| contracts/periphery/WNURA.sol | @uniswap/v2-periphery contracts/test/WETH9.sol (Dapphub WETH9) | 1.1.0-beta.0 | GPL-3.0-or-later |
| contracts/vendor/Multicall3.sol | github.com/mds1/multicall3 | main | MIT |

Local modifications:

- Package imports (`@uniswap/v2-core/...`, `@uniswap/lib/...`) rewritten to relative paths.
- `WNURA.sol`: contract renamed WETH9 to WNURA, name/symbol strings changed to
  "Wrapped NURA"/"WNURA". No functional change. Nothing imports this file — the router
  reaches the wrapped coin through `IWETH` — so the rename touches only the deployed
  contract's own bytecode, not the pair init code hash.
- **Swap fee lowered from 0.30% to 0.25%** (the rate PancakeSwap V2 uses) **and moved
  from a compile-time constant into factory storage**, so it can be retuned after
  launch. This is a change to the AMM's economics and to its trust model, not a rename.
  It touches four files:

  | File | Change |
  | --- | --- |
  | `core/UniswapV2Factory.sol` | `swapFee` (default 25 = 0.25%), `MAX_SWAP_FEE = 100` (1%, `constant`), `setSwapFee` gated on `feeToSetter`, `SwapFeeUpdated` event |
  | `core/interfaces/IUniswapV2Factory.sol` | the three additions above |
  | `core/UniswapV2Pair.sol` | the `UniswapV2: K` check reads `factory.swapFee()` instead of `997/1000` |
  | `periphery/libraries/UniswapV2Library.sol` | `getAmountOut`/`getAmountIn` take the fee as an argument; `swapFee(factory)` reads it; `getAmountsOut`/`getAmountsIn` read it once per route |

  The library quotes and the pair enforces, both from the same slot. If they ever
  disagree, swaps either revert on K or give away value the pool never charged for —
  `test/Swap.test.ts` has a test that changes the fee and then swaps at the exact quote,
  which fails either way round.

  Knock-on: `UniswapV2Router02.getAmountOut`/`getAmountIn` and their declarations in
  `IUniswapV2Router01` are now `view` rather than `pure`, since they read that slot.
  The selectors are unchanged.

  The protocol's own cut, when `feeTo` is set, is still Uniswap's 1/6 of the fee
  (`_mintFee` is unmodified) — PancakeSwap takes 8/25 there instead, which we did not
  copy.
- `periphery/libraries/UniswapV2Library.sol`: the hardcoded pair init code hash is
  regenerated from our compiled Pair bytecode by `scripts/write-init-code-hash.ts`.
  The optimizer settings and evmVersion in hardhat.config.ts are inputs to that
  hash - changing them requires rerunning the codegen.

Compiler pins: core =0.5.16, periphery =0.6.6, optimizer runs 999999,
evmVersion istanbul for both.
