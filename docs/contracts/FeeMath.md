# FeeMath (library)

## Contract Overview

| Property | Value |
| --- | --- |
| Contract name | `FeeMath` |
| Solidity file | `contracts/forecast/libraries/FeeMath.sol` |
| Solidity version | `0.8.24` |
| Contract type | `library` (internal pure; inlined; never deployed) |
| Purpose | Basis-point fee helpers shared by CPMM buy/sell; a trade's fee splits into a protocol cut (forwarded to treasury) and an LP cut (retained in the pool as extra liquidity, lifting LP share value without a per-share accumulator) |

## State Variables

| Name | Type | Value | Purpose |
| --- | --- | --- | --- |
| `BPS` | `uint256` internal constant | `1e4` | Basis-point denominator (100%). Also used as the upper bound when validating `protocolFeeShareBps`. |

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

### protocolCut

```solidity
function protocolCut(uint256 fee, uint16 protocolShareBps) internal pure returns (uint256 cut);
```

`cut = fee · protocolShareBps / 1e4` (floored); remainder stays with LPs.
Used by `buy`, `sell`, and ignored by parimutuel pools.

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
| `protocolCut(fee,shareBps)` | internal | pure | compile-time | Treasury slice of a fee |
