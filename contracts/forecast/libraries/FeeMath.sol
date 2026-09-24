// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title FeeMath
 * @notice Basis-point fee helpers shared by buy and sell. The market escrows the fee and
 *         forwards it to the treasury only when it resolves; a void refunds it.
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
}
