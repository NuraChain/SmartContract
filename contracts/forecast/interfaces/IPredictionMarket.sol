// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { MarketStatus, MarketParams } from "../PredictionTypes.sol";

/**
 * @title IPredictionMarket
 * @notice A single CPMM (fixed-product) prediction market: outcome shares are ERC-1155
 *         tokens (one id per outcome index), collateral is the chain's native token, and the
 *         factory is the market's controller for lifecycle actions.
 */
interface IPredictionMarket {
    // --- initialization (called once by the factory on the clone) ---

    /**
     * @notice Initializes a freshly cloned market and seeds initial liquidity with the
     *         attached native value, minting LP shares to `params.creator`.
     * @param controller The factory allowed to drive lifecycle actions.
     * @param treasury The treasury that receives protocol fees.
     * @param params Immutable market configuration.
     */
    function initialize(address controller, address treasury, MarketParams calldata params) external payable;

    // --- lifecycle (controller only) ---

    /// @notice Halts trading, reversibly.
    function pause() external;

    /// @notice Resumes trading after a pause.
    function unpause() external;

    /// @notice Permanently stops trading ahead of resolution.
    function close() external;

    /**
     * @notice Resolves the market to a winning outcome; winning shares become redeemable 1:1.
     * @param winningOutcome_ Index of the winning outcome.
     */
    function resolve(uint256 winningOutcome_) external;

    /// @notice Voids the market; every outcome redeems for an equal 1/n refund share.
    function voidMarket() external;

    /**
     * @notice Updates the treasury protocol fees are forwarded to.
     * @param treasury New treasury address.
     */
    function setTreasury(address treasury) external;

    // --- trading & liquidity ---

    /**
     * @notice Buys `outcomeIndex` shares with the attached native collateral.
     * @param outcomeIndex Outcome to buy.
     * @param minSharesOut Minimum shares accepted (slippage bound).
     * @param deadline Latest block timestamp the trade may execute at.
     * @return sharesOut Shares minted to the buyer.
     */
    function buy(uint256 outcomeIndex, uint256 minSharesOut, uint256 deadline)
        external
        payable
        returns (uint256 sharesOut);

    /**
     * @notice Sells `outcomeIndex` shares to withdraw `returnAmount` net collateral.
     * @param outcomeIndex Outcome to sell.
     * @param returnAmount Net collateral to receive.
     * @param maxSharesIn Maximum shares the seller will spend (slippage bound).
     * @param deadline Latest block timestamp the trade may execute at.
     * @return sharesIn Shares burned from the seller.
     */
    function sell(uint256 outcomeIndex, uint256 returnAmount, uint256 maxSharesIn, uint256 deadline)
        external
        returns (uint256 sharesIn);

    /**
     * @notice Adds liquidity with the attached native value at the current price.
     * @param minLpSharesOut Minimum LP shares accepted (slippage bound).
     * @return lpShares LP shares minted to the funder.
     */
    function addFunding(uint256 minLpSharesOut) external payable returns (uint256 lpShares);

    /**
     * @notice Removes liquidity, returning a proportional basket of outcome shares.
     * @param lpShares LP shares to burn.
     */
    function removeFunding(uint256 lpShares) external;

    /**
     * @notice Merges `amount` complete sets (one share of every outcome) back into collateral.
     * @param amount Number of complete sets to merge.
     */
    function mergeSets(uint256 amount) external;

    /**
     * @notice Claims collateral for the caller: winning shares (Resolved) or an equal refund
     *         share of every held outcome (Voided).
     * @return payout Collateral paid to the caller.
     */
    function redeem() external returns (uint256 payout);

    // --- views ---

    /// @notice Current lifecycle status.
    function status() external view returns (MarketStatus);

    /// @notice Number of outcomes.
    function outcomeCount() external view returns (uint256);

    /// @notice The winning outcome index (valid only when Resolved).
    function winningOutcome() external view returns (uint256);

    /// @notice Current per-outcome reserves.
    function getReserves() external view returns (uint256[] memory);

    /// @notice Current per-outcome marginal prices in 1e18 (sums to ~1e18).
    function getPrices() external view returns (uint256[] memory);

    /**
     * @notice Preview of shares received for a buy of `amountIn` gross collateral.
     * @param outcomeIndex Outcome to buy.
     * @param amountIn Gross collateral.
     * @return sharesOut Shares that would be minted.
     */
    function calcBuy(uint256 outcomeIndex, uint256 amountIn) external view returns (uint256 sharesOut);

    /**
     * @notice Preview of shares required to withdraw `returnAmount` net collateral.
     * @param outcomeIndex Outcome to sell.
     * @param returnAmount Net collateral to receive.
     * @return sharesIn Shares that would be burned.
     */
    function calcSell(uint256 outcomeIndex, uint256 returnAmount) external view returns (uint256 sharesIn);
}
