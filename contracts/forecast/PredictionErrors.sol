// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title PredictionErrors
 * @notice File-level custom errors shared across the system (Solidity >=0.8.22 allows a
 *         contract to revert with an error declared at file scope). Custom errors are cheaper
 *         than revert strings and give callers a stable, decodable failure surface.
 */

/// @dev Caller lacks the required admin role on the factory.
error NotAdmin();
/// @dev Caller is not the market's controller (the factory).
error NotController();
/// @dev Caller is not one of the resolution signers.
error NotSigner();
/// @dev Caller is not the factory owner.
error NotOwner();
/// @dev The signer list contained a duplicate address.
error DuplicateSigner();
/// @dev Required confirmations must be >= 1 and <= number of signers.
error BadQuorum();
/// @dev A zero address was supplied where a real address is required.
error ZeroAddress();
/// @dev A zero amount was supplied where a positive value is required.
error ZeroAmount();

/// @dev Outcome count is outside the supported range [2, MAX_OUTCOMES].
error InvalidOutcomeCount();
/// @dev Outcome index does not exist in this market.
error InvalidOutcome();
/// @dev Fee configuration is out of range (feeBps too high or share > 100%).
error InvalidFee();
/// @dev lockTime/resolveTime ordering is invalid (must be now < lock <= resolve).
error InvalidTiming();
/// @dev Resolution was attempted before the market's lockTime.
error LockNotReached();

/// @dev Market is not in the Open status required for this action.
error MarketNotOpen();
/// @dev Trading is closed because block.timestamp >= lockTime.
error TradingLocked();
/// @dev Action requires a resolved (or voided) market and it is not one.
error MarketNotResolved();
/// @dev Market has already reached a terminal status (Resolved/Voided).
error MarketAlreadyEnded();

/// @dev A trade's deadline has passed.
error DeadlineExpired();
/// @dev Realised output crossed the caller's slippage bound.
error SlippageExceeded();
/// @dev A reserve is too small to service the requested trade size.
error InsufficientLiquidity();

/// @dev Caller has no winning/refundable balance to redeem.
error NothingToClaim();
/// @dev Native-token transfer via call() returned false.
error TransferFailed();
/// @dev A reentrant call into a guarded function was detected.
error Reentrancy();
/// @dev Pagination offset is beyond the end of the list.
error OffsetOutOfRange();
