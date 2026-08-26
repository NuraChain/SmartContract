// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { MarketKind, MarketStatus, MarketParams, MarketRecord } from "../PredictionTypes.sol";

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

    /**
     * @notice Deploys a new parimutuel pool market: users bet native collateral directly on an
     *        outcome until `lockTime`; an admin then resolves the winner, the house fee is
     *        deducted once from the whole pool, and the remainder is shared pro-rata among
     *        the winning outcome's backers. Needs no seed liquidity, so it is not payable.
     * @param params Market configuration; a `feeBps` of 0 inherits the factory default (this
     *        is where the fee percentage per market type/category comes from).
     * @return marketId The market's registry index.
     * @return market The deployed clone address.
     */
    function createMarket2(MarketParams calldata params) external returns (uint256 marketId, address market);

    /// @notice Pauses a market (admin only).
    function pauseMarket(uint256 marketId) external;

    /// @notice Unpauses a market (admin only).
    function unpauseMarket(uint256 marketId) external;

    /// @notice Closes a market (admin only).
    function closeMarket(uint256 marketId) external;

    /**
     * @notice Casts a resolution signer's vote for a market's winning outcome. When any
     *         outcome accumulates `requiredConfirmations()` distinct votes, the market is
     *         resolved on-chain in the same transaction (admin multisig, N-of-M).
     * @param marketId Market to resolve.
     * @param winningOutcome Outcome the signer is confirming.
     */
    function confirmResolution(uint256 marketId, uint256 winningOutcome) external;

    /// @notice Replaces the resolution signer set and quorum in one shot (owner only).
    /// @param signers New signer addresses; unique and non-zero.
    /// @param required New confirmation threshold; 1 <= required <= signers.length.
    function setResolutionSigners(address[] calldata signers, uint256 required) external;

    /// @notice The addresses allowed to confirm resolutions.
    function resolutionSigners() external view returns (address[] memory);

    /// @notice True when `account` is in the current signer set.
    function isResolutionSigner(address account) external view returns (bool);

    /// @notice Distinct votes needed on one outcome to resolve a market.
    function requiredConfirmations() external view returns (uint256);

    /// @notice Current tally for `outcome` on `marketId`.
    function confirmationCount(uint256 marketId, uint256 outcome) external view returns (uint256);

    /// @notice The outcome `signer` voted for on `marketId`, or type(uint256).max when none.
    function confirmationOf(uint256 marketId, address signer) external view returns (uint256);

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

    /// @notice Which engine a market runs on (AMM shares vs parimutuel pool).
    function marketKind(uint256 marketId) external view returns (MarketKind);

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
