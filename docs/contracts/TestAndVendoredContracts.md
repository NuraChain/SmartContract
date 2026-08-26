# Test Mocks and Vendored Contracts

These contracts ship in the repository but are **not deployable protocol surface**:
they exist for the test suites, or are vendored third-party code.

## Test mocks (first-party, test-only)

| File | Contract | Role |
| --- | --- | --- |
| `contracts/forecast/mocks/ReentrantBuyer.sol` | `ReentrantBuyer` | Attempts a re-entrant `buy` against a `PredictionMarket` clone during a callback; proves the storage reentrancy lock holds. |
| `contracts/airdrop/mocks/AirdropMocks.sol` | `IAirdrop` (interface), `ReentrantClaimer`, `RejectingClaimer` | `ReentrantClaimer` re-enters `getReward` from its receive path (blocked by guard + CEI); `RejectingClaimer` refuses payouts to prove failed sends cannot corrupt claim state. |
| `contracts/vault/mocks/VaultMocks.sol` | `MockConfigurableERC20`, `MockReentrantERC20`, `MockReentrantReceiver` | Misbehaving ERC20s (transfer hooks that re-enter deposit/redeem) and an ERC-721 receiver that re-enters mint; used by `Vault.test.ts` and the Solidity fuzz/invariant suites. |

None of these hold funds in production deployments and none are referenced by Ignition
modules.

## Vendored: Uniswap V3 (`contracts/univ3/`)

Uniswap V3 core + periphery vendored verbatim with package imports rewritten to relative
paths, plus one documented local modification (a `chainId == 1020` branch in
`NonfungibleTokenPositionDescriptor.tokenRatioPriority`, mirroring upstream's Ethereum
treatment for bridged tokens). Provenance, licenses (GPL-2.0-or-later for V3, expired-BUSL
files noted, MIT/GPL-3 vendor subsets) and every modification are recorded in
[`contracts/univ3/VENDORED.md`](../../contracts/univ3/VENDORED.md).

Deployable entry points (documented exhaustively by Uniswap's own docs and audits):

| Contract | Path | Purpose |
| --- | --- | --- |
| `UniswapV3Factory` | `univ3/core/UniswapV3Factory.sol` | Creates one pool per (token pair, fee tier) |
| `UniswapV3Pool` | `univ3/core/UniswapV3Pool.sol` | Concentrated-liquidity pool (deployed by factory, not directly) |
| `NonfungiblePositionManager` | `univ3/periphery/...` | Liquidity positions as ERC-721s |
| `SwapRouter` | `univ3/periphery/SwapRouter.sol` | Exact-in/exact-out single & multi-pool swaps |
| `QuoterV2` | `univ3/periphery/lens/QuoterV2.sol` | Quotes by simulating + reverting (static-call only) |
| `TickLens`, `NFTDescriptor`, `NonfungibleTokenPositionDescriptor` | periphery | Tooling/metadata |

Build constraints (load-bearing): solc **0.7.6** exactly, upstream optimizer runs,
`metadata.bytecodeHash: "none"`, evmVersion `istanbul` — these reproduce Uniswap's own
pool init-code hash byte-for-byte and keep every contract under Nurachain's 24 576-byte
EIP-170 limit (asserted by `test/univ3/Build.test.ts`). Per-contract deep documentation is
intentionally not duplicated here; consult upstream Uniswap V3 documentation.
