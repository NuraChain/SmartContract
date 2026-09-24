# FeeMath (library)

## Contract Overview

| Property | Value |
| --- | --- |
| Contract name | `FeeMath` |
| Solidity file | `contracts/forecast/libraries/FeeMath.sol` |
| Solidity version | `0.8.24` |
| Contract type | `library` (internal pure; inlined; never deployed) |
| Purpose | Basis-point fee helpers shared by CPMM buy/sell; the market escrows the fee and forwards it to the treasury only on resolve; a cancellation refunds it |

## State Variables

| Name | Type | Value | Purpose |
| --- | --- | --- | --- |
| `BPS` | `uint256` internal constant | `1e4` | Basis-point denominator (100%). |

## Functions

All `internal pure`.

---

### feeOnAmount

```solidity
function feeOnAmount(uint256 amount, uint16 feeBps) internal pure returns (uint256 fee);
```

`fee = amount · feeBps / 1e4` (floored). Charged on a **buy's gross input**.
Used by `buy`, `calcBuy`, and pool-side validation.

### grossFromNet

```solidity
function grossFromNet(uint256 net, uint16 feeBps) internal pure returns (uint256 gross);
```

`gross = ceil(net · 1e4 / (1e4 − feeBps))` via `Math.mulDiv(..., Ceil)` — the collateral a
sell must pull from the pool so the seller nets `net`; rounded up so the fee is never
understated. Used by `sell`, `calcSell`.

## Security Analysis

- Rounding always favours fee integrity (never understates fees).
- Pure arithmetic under 0.8 checked math; `feeBps == 1e4` would divide by zero in
  `grossFromNet` — unreachable because constructors cap `feeBps ≤ 1000 < 10000`.
- **No issue detected.**

## Function Reference

| Function | Visibility | Mutability | Access | Purpose |
| --- | --- | --- | --- | --- |
| `feeOnAmount(amount,bps)` | internal | pure | compile-time | Fee on a buy input |
| `grossFromNet(net,bps)` | internal | pure | compile-time | Gross-of-fee sell amount |
