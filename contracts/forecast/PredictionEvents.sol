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
    string category,
    uint256 outcomeCount,
    uint256 initialFunding
);

/// @notice A market was paused by an admin (trading halted, reversible).
event MarketPaused(address indexed market);

/// @notice A paused market was resumed.
event MarketUnpaused(address indexed market);

/// @notice A market was permanently closed ahead of resolution.
event MarketClosed(address indexed market);

/// @notice A market was resolved to a winning outcome.
event MarketResolved(address indexed market, uint256 indexed winningOutcome);

/// @notice A market was voided; every outcome pays an equal refund share.
event MarketVoided(address indexed market);

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

/// @notice A winner (or refund) claim: `amount` collateral paid to `claimant`.
event RewardClaimed(address indexed market, address indexed claimant, uint256 amount);

/// @notice Protocol fee forwarded to the treasury from `market`.
event FeeCollected(address indexed market, uint256 amount);

/// @notice Treasury withdrew `amount` to the fee recipient.
event FeeWithdrawn(address indexed to, uint256 amount);

/// @notice The treasury's fee recipient changed.
event FeeRecipientChanged(address indexed recipient);

/// @notice The factory's treasury address changed.
event TreasuryUpdated(address indexed treasury);

/// @notice The factory's default fee configuration changed.
event FeesUpdated(uint16 feeBps, uint16 protocolFeeShareBps);
