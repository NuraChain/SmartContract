// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { MarketStatus } from "./PredictionTypes.sol";

/**
 * @title PredictionEvents
 * @notice File-level events shared by the factory, markets, and treasury (Solidity >=0.8.22
 *         lets a contract emit an event declared at file scope). One declaration site keeps
 *         the emitted topics identical across every contract that logs them.
 */

/// @notice A new market clone was deployed by the factory.
event MarketCreated(
    uint256 indexed marketId,
    address indexed market,
    address indexed creator,
    uint32 categoryId,
    uint256 outcomeCount,
    uint256 initialFunding
);

/// @notice A category was registered on the factory. Markets refer to it by this id; the
///         text shown to a reader comes from {CategoryMeaningSet}, one entry per language.
event CategoryAdded(uint32 indexed categoryId);

/// @notice What category `categoryId` means in `lang` (a short tag such as "en" or "fa",
///         left-aligned in bytes8). Setting it again replaces the previous text.
event CategoryMeaningSet(uint32 indexed categoryId, bytes8 indexed lang, string meaning);

/// @notice A category was opened for, or retired from, new markets. Retiring never touches
///         the markets already filed under it.
event CategoryEnabledSet(uint32 indexed categoryId, bool enabled);

/// @notice A market was resolved to a winning outcome.
event MarketResolved(address indexed market, uint256 indexed winningOutcome);

/// @notice A market was cancelled; every participant can take back what they put in.
event MarketCancelled(address indexed market);

/// @notice A buy trade: `buyer` spent `amountIn` collateral for `sharesOut` of `outcome`.
event PredictionPlaced(
    address indexed market,
    address indexed buyer,
    uint256 indexed outcome,
    uint256 amountIn,
    uint256 sharesOut
);

/// @notice A bet on a pool market: `better` staked `amount` collateral on `outcome`.
event BetPlaced(address indexed market, address indexed better, uint256 indexed outcome, uint256 amount);

/// @notice A sell trade: `seller` returned `sharesIn` of `outcome` for `amountOut` collateral.
event PredictionSold(
    address indexed market,
    address indexed seller,
    uint256 indexed outcome,
    uint256 sharesIn,
    uint256 amountOut
);

/// @notice Liquidity added; `funder` received `lpShares`.
event LiquidityAdded(address indexed market, address indexed funder, uint256 amount, uint256 lpShares);

/// @notice Liquidity removed; `provider` burned `lpShares`.
event LiquidityRemoved(address indexed market, address indexed provider, uint256 lpShares);

/// @notice A winner (or refund) claim: `amount` collateral paid to `claimant`. One per
///         account per settlement, so an indexer sees each participant exactly once.
event RewardClaimed(address indexed market, address indexed claimant, uint256 amount);

/// @notice Protocol fee forwarded to the treasury from `market`.
event FeeCollected(address indexed market, uint256 amount);

/// @notice Collateral left unclaimed after a market's claim window expired was swept to
///         `treasury`. Logged separately from {FeeCollected} so residue never reads as
///         trading revenue in fee reporting.
event UnclaimedSwept(address indexed market, address indexed treasury, uint256 amount);

/// @notice Treasury withdrew `amount` to the fee recipient.
event FeeWithdrawn(address indexed to, uint256 amount);

/// @notice The treasury's fee recipient changed.
event FeeRecipientChanged(address indexed recipient);

/// @notice The factory's treasury address changed.
event TreasuryUpdated(address indexed treasury);

/// @notice The factory's default fee configuration changed.
event FeesUpdated(uint16 feeBps);

/// @notice A resolution signer voted `outcome` for market `marketId`; `count` is that
///         outcome's tally after the vote (a changed vote removes it from the old one).
event ResolutionConfirmed(
    uint256 indexed marketId,
    address indexed signer,
    uint256 indexed outcome,
    uint256 count
);

/// @notice A market reached the confirmation quorum and was resolved on-chain.
event ResolutionExecuted(uint256 indexed marketId, uint256 indexed outcome, uint256 confirmations);

/// @notice The owner replaced the resolution signer set and/or the required quorum.
event ResolutionSignersUpdated(address[] signers, uint256 required);
