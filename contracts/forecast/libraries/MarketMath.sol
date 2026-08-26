// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { InsufficientLiquidity } from "../PredictionErrors.sol";

/**
 * @title MarketMath
 * @notice The fixed-product market-maker (FPMM) trade and pricing math, over an array of
 *         per-outcome reserves. The constant-product invariant is `∏ r_j = k`; because the
 *         formulas are product/ratio-based they need only {Math-mulDiv} (no log/exp, no
 *         exotic fixed-point library).
 * @dev Reserves and amounts are in collateral base units (wei). Buys round in the pool's
 *      favour (floor), sells round in the pool's favour (ceil), so the maker can never be
 *      drained by rounding.
 */
library MarketMath {
    /// @dev 1e18 fixed-point scale for reported prices.
    uint256 internal constant WAD = 1e18;

    /**
     * @notice Outcome shares minted for buying `investment` collateral of `outcomeIndex`.
     * @dev `endReserve = r_i · ∏_{j≠i} r_j/(r_j+investment)`; sharesOut = r_i + investment - endReserve.
     * @param reserves Current per-outcome reserves.
     * @param outcomeIndex Outcome being bought.
     * @param investment Collateral going into the pool (net of fees).
     * @return sharesOut Outcome tokens the buyer receives.
     */
    function calcBuyShares(uint256[] memory reserves, uint256 outcomeIndex, uint256 investment)
        internal
        pure
        returns (uint256 sharesOut)
    {
        uint256 n = reserves.length;
        uint256 endReserve = reserves[outcomeIndex];
        for (uint256 j = 0; j < n; ++j) {
            if (j != outcomeIndex) {
                uint256 r = reserves[j];
                endReserve = Math.mulDiv(endReserve, r, r + investment);
            }
        }
        sharesOut = reserves[outcomeIndex] + investment - endReserve;
    }

    /**
     * @notice Outcome shares a seller must return to withdraw `grossFromPool` collateral of
     *         `outcomeIndex` (gross = the seller's net receipt plus the trade fee).
     * @dev `endReserve = r_i · ∏_{j≠i} r_j/(r_j-grossFromPool)` (ceil); sharesIn = endReserve + gross - r_i.
     *      Reverts {InsufficientLiquidity} if any other reserve cannot cover the withdrawal.
     * @param reserves Current per-outcome reserves.
     * @param outcomeIndex Outcome being sold.
     * @param grossFromPool Collateral removed from the pool for this trade.
     * @return sharesIn Outcome tokens the seller must provide.
     */
    function calcSellShares(uint256[] memory reserves, uint256 outcomeIndex, uint256 grossFromPool)
        internal
        pure
        returns (uint256 sharesIn)
    {
        uint256 n = reserves.length;
        uint256 endReserve = reserves[outcomeIndex];
        for (uint256 j = 0; j < n; ++j) {
            if (j != outcomeIndex) {
                uint256 r = reserves[j];
                if (r <= grossFromPool) revert InsufficientLiquidity();
                endReserve = Math.mulDiv(endReserve, r, r - grossFromPool, Math.Rounding.Ceil);
            }
        }
        sharesIn = endReserve + grossFromPool - reserves[outcomeIndex];
    }

    /**
     * @notice Marginal prices of every outcome in WAD; the array sums to ~1e18.
     * @dev `p_i = (1/r_i) / Σ_k (1/r_k)` - computed via reciprocals so no product of reserves
     *      is ever formed, keeping the view overflow-safe for any supported outcome count.
     * @param reserves Current per-outcome reserves.
     * @return out Prices in 1e18 fixed point.
     */
    function prices(uint256[] memory reserves) internal pure returns (uint256[] memory out) {
        uint256 n = reserves.length;
        out = new uint256[](n);
        uint256[] memory inv = new uint256[](n);
        uint256 sumInv;
        for (uint256 i = 0; i < n; ++i) {
            uint256 r = reserves[i];
            uint256 x = r == 0 ? 0 : (1e36 / r);
            inv[i] = x;
            sumInv += x;
        }
        if (sumInv == 0) {
            return out;
        }
        for (uint256 i = 0; i < n; ++i) {
            out[i] = Math.mulDiv(inv[i], WAD, sumInv);
        }
    }

    /**
     * @notice Largest reserve in the array (used by proportional funding math).
     * @param reserves Current per-outcome reserves.
     * @return max The maximum reserve value.
     */
    function maxReserve(uint256[] memory reserves) internal pure returns (uint256 max) {
        uint256 n = reserves.length;
        for (uint256 i = 0; i < n; ++i) {
            if (reserves[i] > max) {
                max = reserves[i];
            }
        }
    }
}
