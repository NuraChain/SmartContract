// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title IPredictionTreasury
 * @notice Collects protocol fees from markets and lets the owner withdraw them to the fee
 *         recipient.
 */
interface IPredictionTreasury {
    /**
     * @notice Records an incoming protocol fee attributed to `market`.
     * @param market The market the fee originated from.
     */
    function depositFee(address market) external payable;

    /**
     * @notice Withdraws `amount` of collected fees to the current fee recipient.
     * @param amount Amount to withdraw.
     */
    function withdraw(uint256 amount) external;

    /**
     * @notice Sets the address that receives withdrawals.
     * @param recipient New fee recipient.
     */
    function setFeeRecipient(address recipient) external;

    /// @notice The current fee recipient.
    function feeRecipient() external view returns (address);

    /// @notice Total fees ever collected (across all markets).
    function totalCollected() external view returns (uint256);

    /// @notice Fees collected from a specific market.
    function collectedFor(address market) external view returns (uint256);
}
