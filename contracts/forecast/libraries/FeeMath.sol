// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title FeeMath
 * @notice Basis-point fee helpers shared by buy and sell. A trade's fee splits into a
 *         protocol cut (forwarded to the treasury) and an LP cut (retained in the pool as
 *         extra liquidity, which lifts the value of LP shares without a per-share accumulator).
 */
library FeeMath {
    /// @dev Basis-point denominator (1e4 = 100%).
    uint256 internal constant BPS = 1e4;

    /**
     * @notice Fee charged on a buy of `amount` collateral.
     * @param amount Gross collateral sent by the buyer.
     * @param feeBps Total trade fee in basis points.
     * @return fee The fee amount.
     */
    function feeOnAmount(uint256 amount, uint16 feeBps) internal pure returns (uint256 fee) {
        fee = (amount * feeBps) / BPS;
    }

    /**
     * @notice Gross collateral a sell must remove from the pool so the seller nets `net`.
     * @dev `gross = net · BPS / (BPS - feeBps)`, rounded up so the fee is never understated.
     * @param net Collateral the seller wants to receive.
     * @param feeBps Total trade fee in basis points.
     * @return gross Collateral removed from the pool (net + fee).
     */
    function grossFromNet(uint256 net, uint16 feeBps) internal pure returns (uint256 gross) {
        gross = Math.mulDiv(net, BPS, BPS - feeBps, Math.Rounding.Ceil);
    }

    /**
     * @notice The protocol's share of a fee.
     * @param fee Total fee.
     * @param protocolShareBps Protocol share of the fee in basis points.
     * @return cut Portion routed to the treasury (remainder stays with LPs).
     */
    function protocolCut(uint256 fee, uint16 protocolShareBps) internal pure returns (uint256 cut) {
        cut = (fee * protocolShareBps) / BPS;
    }
}
