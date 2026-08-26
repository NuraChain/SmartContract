# MarketMath (library)

## Contract Overview

| Property | Value |
| --- | --- |
| Contract name | `MarketMath` |
| Solidity file | `contracts/forecast/libraries/MarketMath.sol` |
| Solidity version | `0.8.24` |
| Contract type | `library` (internal functions — inlined at compile time; never deployed) |
| Purpose | Fixed-product market-maker (FPMM) trade and pricing math over an array of per-outcome reserves |

The constant-product invariant is `∏ r_j = k`. Because the formulas are product/ratio
based, only OpenZeppelin's `Math.mulDiv` is needed — no log/exp, no fixed-point library.
**Rounding policy:** buys floor the share output and sells ceil the required input, both
in the pool's favour, so rounding can never drain the maker.

## Inheritance / Interfaces

None (library). Depends only on OZ `Math`.

## State Variables

None. One internal constant:

| Name | Value | Purpose |
| --- | --- | --- |
| `WAD` | `1e18` | Fixed-point scale for reported prices |

## Functions

All functions are `internal pure` operating on `uint256[] memory reserves`.

---

### calcBuyShares

```solidity
function calcBuyShares(uint256[] memory reserves, uint256 outcomeIndex, uint256 investment)
    internal pure returns (uint256 sharesOut);
```

Shares minted for buying with net-of-fee collateral `investment`.
`endReserve = r_i · ∏_{j≠i} r_j/(r_j + investment)` (floored via mulDiv);
`sharesOut = r_i + investment − endReserve`. Floors favour the pool.

### calcSellShares

```solidity
function calcSellShares(uint256[] memory reserves, uint256 outcomeIndex, uint256 grossFromPool)
    internal pure returns (uint256 sharesIn);
```

Tokens required to withdraw `grossFromPool` collateral:
`endReserve = r_i · ∏_{j≠i} r_j/(r_j − gross)` **ceil-rounded**;
`sharesIn = endReserve + gross − r_i`.
Reverts [`InsufficientLiquidity`](PredictionErrors) if any other reserve ≤ gross.
Called by `PredictionMarket.sell`/`calcSell`.

### prices

```solidity
function prices(uint256[] memory reserves) internal pure returns (uint256[] memory out);
```

Marginal prices in WAD: `p_i = (1e36/r_i) / Σ_k (1e36/r_k)` — computed through
reciprocals so no reserve product is ever formed (overflow-safe for any n). Zero reserve ⇒
price 0 contribution; all-zero ⇒ all-zero output. Used by `getPrices()`.

### maxReserve

```solidity
function maxReserve(uint256[] memory reserves) internal pure returns (uint256 max);
```

Largest reserve; used by `addFunding`'s proportional funding math.

## Security Analysis

- **Precision:** every division goes through `Math.mulDiv` (no intermediate overflow);
  explicit round direction per trade side.
- **No issue detected:** pure functions, no state, no external calls.
- Callers must pre-validate indices (`calcBuyShares` indexes without bounds checks;
  `PredictionMarket._requireTradable` guarantees validity).

## Function Reference

| Function | Visibility | Mutability | Access | Purpose |
| --- | --- | --- | --- | --- |
| `calcBuyShares(reserves,i,in)` | internal | pure | compile-time | Buy quote (floor) |
| `calcSellShares(reserves,i,gross)` | internal | pure | compile-time | Sell quote (ceil) |
| `prices(reserves)` | internal | pure | compile-time | WAD marginal prices |
| `maxReserve(reserves)` | internal | pure | compile-time | Largest reserve |
