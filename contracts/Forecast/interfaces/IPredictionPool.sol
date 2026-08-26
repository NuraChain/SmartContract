// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { MarketStatus, MarketParams } from "../PredictionTypes.sol";

/**
 * @title IPredictionPool
 * @notice A parimutuel prediction market: participants bet native collateral directly on an
 *         outcome while the market is open; after `lockTime` an admin resolves the winner,
 *         the house fee is deducted once from the whole pool, and every backer of the winning
 *         outcome claims a pro-rata share of what remains. No shares are minted and there is
 *         no secondary trading — unlike the CPMM {IPredictionMarket}.
 */
interface IPredictionPool {
    // --- initialization (called once by the factory on the clone) ---

    /**
     * @notice Initializes a freshly cloned pool market. Not payable: a pool needs no seed
     *        liquidity, its pool forms from bets.
     * @param controller The factory allowed to drive lifecycle actions.
     * @param treasury The treasury that receives the resolution fee.
     * @param params Immutable market configuration.
     */
    function initialize(address controller, address treasury, MarketParams calldata params) external;

    // --- lifecycle (controller only) ---

    /// @notice Halts betting, reversibly.
    function pause() external;

    /// @notice Resumes betting after a pause.
    function unpause() external;

    /// @notice Permanently stops betting ahead of resolution.
    function close() external;

    /**
     * @notice Declares the winning outcome; impossible before `lockTime`.
     * @param winningOutcome_ Index of the winning outcome.
     */
    function resolve(uint256 winningOutcome_) external;

    /// @notice Voids the market; every bettor gets their own stake back, fee-free.
    function voidMarket() external;

    /**
     * @notice Updates the treasury the resolution fee is forwarded to.
     * @param treasury New treasury address.
     */
    function setTreasury(address treasury) external;

    // --- betting & redemption ---

    /**
     * @notice Bets the attached native collateral on `outcomeIndex`.
     * @param outcomeIndex Outcome to back.
     * @return staked The amount recorded for the caller.
     */
    function bet(uint256 outcomeIndex) external payable returns (uint256 staked);

    /**
     * @notice Claims the caller's payout: their pro-rata slice of the pool net of fee after
     *        resolution, or their full stake back after a void. One-shot per account.
     * @return payout Collateral paid to the caller.
     */
    function claim() external returns (uint256 payout);

    // --- views ---

    /// @notice Current lifecycle status.
    function status() external view returns (MarketStatus);

    /// @notice Number of outcomes.
    function outcomeCount() external view returns (uint256);

    /// @notice The winning outcome index (valid only when Resolved).
    function winningOutcome() external view returns (uint256);

    /// @notice Total collateral bet across all outcomes.
    function totalPool() external view returns (uint256);

    /// @notice Total collateral bet on `outcomeIndex`.
    function stakedFor(uint256 outcomeIndex) external view returns (uint256);

    /// @notice The caller's current stake on `outcomeIndex`.
    function myStake(uint256 outcomeIndex) external view returns (uint256);

    /// @notice Collateral available to winners after the resolution fee.
    function distributableAmount() external view returns (uint256);

    /**
     * @notice What the caller would receive if the market resolved right now to
     *        `outcomeIndex`.
     */
    function previewPayout(uint256 outcomeIndex) external view returns (uint256);

    /// @notice Implied odds of `outcomeIndex`: its stake as a fraction of the pool (1e18 WAD).
    function impliedOdds(uint256 outcomeIndex) external view returns (uint256);

    /// @notice The display name of `outcomeIndex`.
    function outcomeName(uint256 outcomeIndex) external view returns (string memory);
}
