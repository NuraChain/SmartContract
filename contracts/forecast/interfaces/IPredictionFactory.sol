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
     * @param params Market configuration; a `feeBps` of 0 inherits the factory default.
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

    /// @notice Cancels a market so everyone takes back what they put in (admin only).
    function cancelMarket(uint256 marketId) external;

    /**
     * @notice Sweeps whatever collateral a settled market still holds into the treasury,
     *        once its claim window has expired (admin only).
     * @param marketId Market to sweep.
     * @return amount Collateral moved to the treasury.
     */
    function sweepUnclaimed(uint256 marketId) external returns (uint256 amount);

    /// @notice Updates the treasury applied to newly created markets (admin only). Existing
    ///         markets are re-pointed individually to keep gas bounded.
    function setTreasury(address treasury) external;

    /**
     * @notice Updates the default fee configuration applied to new markets (admin only).
     * @param feeBps Total trade fee in basis points; the whole fee goes to the treasury.
     */
    function setDefaultFees(uint16 feeBps) external;

    // --- category registry ---

    /**
     * @notice Registers a category id and what it means, in one language or several (admin
     *        only). Markets carry the id; every name a reader sees is looked up here, so
     *        translating or renaming a category never touches a market.
     * @dev Id 0 is reserved, so a market created with an unset category fails loudly. The
     *      batch must include the default language, because that is what every lookup falls
     *      back to. New categories start enabled.
     * @param categoryId Non-zero id to register.
     * @param langs Language tags, short codes left-aligned in bytes8 ("en", "fa", "pt-BR").
     * @param meanings What the category is called in each of those languages, same order.
     */
    function addCategory(uint32 categoryId, bytes8[] calldata langs, string[] calldata meanings) external;

    /**
     * @notice Adds or replaces translations for a registered category (admin only).
     * @param categoryId Category to translate.
     * @param langs Language tags.
     * @param meanings What the category is called in each, same order.
     */
    function setCategoryMeanings(uint32 categoryId, bytes8[] calldata langs, string[] calldata meanings) external;

    /**
     * @notice Opens a category for new markets, or retires it (admin only). Retiring leaves
     *        the markets already filed under it untouched and still listable.
     * @param categoryId Category to configure.
     * @param enabled Whether new markets may use it.
     */
    function setCategoryEnabled(uint32 categoryId, bool enabled) external;

    /**
     * @notice What a category is called in `lang`, falling back to the default language when
     *        that one has not been translated yet.
     * @param categoryId Category to read.
     * @param lang Language tag.
     * @return The display name; empty only for an unregistered category.
     */
    function categoryMeaning(uint32 categoryId, bytes8 lang) external view returns (string memory);

    /**
     * @notice Every translation a category carries.
     * @param categoryId Category to read.
     * @return langs Language tags, in the order they were first set.
     * @return meanings The name in each of those languages.
     */
    function categoryMeanings(uint32 categoryId)
        external
        view
        returns (bytes8[] memory langs, string[] memory meanings);

    /// @notice The language tags a category has been named in.
    function categoryLanguages(uint32 categoryId) external view returns (bytes8[] memory);

    /// @notice Every registered category id, in registration order.
    function categoryIds() external view returns (uint32[] memory);

    /// @notice How many categories are registered.
    function categoryCount() external view returns (uint256);

    /// @notice Whether a category was ever registered, and whether it still takes new markets.
    function categoryState(uint32 categoryId) external view returns (bool known, bool enabled);

    /**
     * @notice A page of markets filed under one category.
     * @param categoryId Category to list.
     * @param offset Number of matching records to skip.
     * @param limit Maximum records to return.
     */
    function marketsByCategory(uint32 categoryId, uint256 offset, uint256 limit)
        external
        view
        returns (MarketRecord[] memory);

    /// @notice Number of markets filed under a category.
    function countByCategory(uint32 categoryId) external view returns (uint256);

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

    /// @notice A page of Resolved markets.
    function resolvedMarkets(uint256 offset, uint256 limit) external view returns (MarketRecord[] memory);
}
