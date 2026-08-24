// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { MarketStatus, MarketParams, MarketRecord } from "../PredictionTypes.sol";

/**
 * @title IPredictionFactory
 * @notice Deploys and administers prediction markets, and serves the paginated registry the
 *         frontend reads.
 */
interface IPredictionFactory {
    // --- admin actions ---

    /**
     * @notice Deploys a new market clone, seeding it with the attached native value.
     * @param params Market configuration; `feeBps`/`protocolFeeShareBps` of 0 inherit the
     *        factory defaults.
     * @return marketId The market's registry index.
     * @return market The deployed clone address.
     */
    function createMarket(MarketParams calldata params)
        external
        payable
        returns (uint256 marketId, address market);

    /// @notice Pauses a market (admin only).
    function pauseMarket(uint256 marketId) external;

    /// @notice Unpauses a market (admin only).
    function unpauseMarket(uint256 marketId) external;

    /// @notice Closes a market (admin only).
    function closeMarket(uint256 marketId) external;

    /**
     * @notice Resolves a market to a winning outcome (admin only).
     * @param marketId Market to resolve.
     * @param winningOutcome Winning outcome index.
     */
    function resolveMarket(uint256 marketId, uint256 winningOutcome) external;

    /// @notice Voids a market for equal refunds (admin only).
    function voidMarket(uint256 marketId) external;

    /// @notice Updates the treasury applied to newly created markets (admin only). Existing
    ///         markets are re-pointed individually to keep gas bounded.
    function setTreasury(address treasury) external;

    /**
     * @notice Updates the default fee configuration applied to new markets (admin only).
     * @param feeBps Total trade fee in basis points.
     * @param protocolFeeShareBps Protocol share of each fee in basis points.
     */
    function setDefaultFees(uint16 feeBps, uint16 protocolFeeShareBps) external;

    // --- registry views ---

    /// @notice Total number of markets ever created.
    function marketCount() external view returns (uint256);

    /// @notice The record for a market by id.
    function marketAt(uint256 marketId) external view returns (MarketRecord memory);

    /// @notice The clone address for a market by id.
    function marketAddress(uint256 marketId) external view returns (address);

    /// @notice The treasury protocol fees flow into.
    function treasury() external view returns (address);

    /**
     * @notice A page of all markets (newest ids first is the frontend's concern; this returns
     *         ascending ids from `offset`).
     * @param offset First id to include.
     * @param limit Maximum records to return.
     */
    function marketsPaged(uint256 offset, uint256 limit) external view returns (MarketRecord[] memory);

    /**
     * @notice A page of markets filtered by lifecycle status.
     * @param status Status to filter on.
     * @param offset Number of matching records to skip.
     * @param limit Maximum records to return.
     */
    function marketsByStatus(MarketStatus status, uint256 offset, uint256 limit)
        external
        view
        returns (MarketRecord[] memory);

    /// @notice A page of Open markets.
    function activeMarkets(uint256 offset, uint256 limit) external view returns (MarketRecord[] memory);

    /// @notice A page of Closed markets.
    function closedMarkets(uint256 offset, uint256 limit) external view returns (MarketRecord[] memory);

    /// @notice A page of Resolved markets.
    function resolvedMarkets(uint256 offset, uint256 limit) external view returns (MarketRecord[] memory);
}
