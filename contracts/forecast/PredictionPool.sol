// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import { IPredictionPool } from "./interfaces/IPredictionPool.sol";
import { IPredictionTreasury } from "./interfaces/IPredictionTreasury.sol";
import { MarketStatus, MarketParams } from "./PredictionTypes.sol";
import { FeeMath } from "./libraries/FeeMath.sol";
import {
    ZeroAddress,
    ZeroAmount,
    InvalidOutcome,
    InvalidOutcomeCount,
    InvalidFee,
    InvalidTiming,
    NotController,
    MarketNotOpen,
    TradingLocked,
    MarketNotResolved,
    MarketAlreadyEnded,
    LockNotReached,
    NothingToClaim,
    TransferFailed,
    Reentrancy
} from "./PredictionErrors.sol";
import {
    BetPlaced,
    RewardClaimed,
    MarketPaused,
    MarketUnpaused,
    MarketClosed,
    MarketResolved,
    MarketVoided
} from "./PredictionEvents.sol";

/**
 * @title PredictionPool
 * @notice A parimutuel prediction market, deployed as an EIP-1167 clone by {PredictionFactory}
 *         via `createMarket2`. Unlike the CPMM {PredictionMarket}, there is no trading and no
 *         liquidity provider: participants bet native collateral directly on an outcome while
 *         the market is open, and after `lockTime` an admin declares the winner. The house fee
 *         is deducted once from the whole pool, and every backer of the winning outcome then
 *         claims a share of what remains, proportional to their stake.
 *
 *          payout(user) = (totalPool − fee) · stakeOnWinner(user) / totalStakedOnWinner
 *
 * @dev Bets are plain deposits accounted per (user, outcome); nothing is minted. Claims are
 *      pull-payment and one-shot (`_claimed` flag), so double claiming is impossible by
 *      construction. Resolution cannot happen before `lockTime` — the pool must be closed to
 *      new money before a winner can be declared. Rounding floors every payout; the sub-unit
 *      dust stays in the contract. `params.protocolFeeShareBps` is ignored here: the full fee
 *      goes to the treasury, because there are no LPs to retain the rest for.
 */
contract PredictionPool is IPredictionPool, Initializable {
    /// @notice Maximum supported outcomes (bounds every per-outcome loop).
    uint256 public constant MAX_OUTCOMES = 16;

    /// @notice Maximum total fee (10%).
    uint16 public constant MAX_FEE_BPS = 1000;

    /// @notice The factory; the only address allowed to drive lifecycle actions.
    address public controller;

    /// @notice Treasury that receives the resolution fee.
    address public treasury;

    /// @notice Current lifecycle status.
    MarketStatus public status;

    /// @notice Human-readable market metadata.
    string public title;
    string public description;
    string public category;
    string public imageURI;

    /// @notice Account credited as the market's creator.
    address public creator;

    /// @notice Creation timestamp.
    uint64 public createdAt;
    /// @notice Betting closes at this timestamp; resolution is impossible before it.
    uint64 public lockTime;
    /// @notice Intended resolution timestamp (informational; admin resolves).
    uint64 public resolveTime;

    /// @notice House fee in basis points, deducted once from the pool at resolution.
    uint16 public feeBps;
    /// @notice Unused by pool markets (kept for parameter-shape parity with the CPMM).
    uint16 public protocolFeeShareBps;

    /// @notice Number of outcomes.
    uint256 public outcomeCount;

    /// @dev Per-outcome display names.
    string[] private _outcomeNames;

    /// @notice Total collateral bet across all outcomes.
    uint256 public totalPool;

    /// @notice Collateral left for winners after the fee was taken at resolution.
    uint256 private _distributable;

    /// @dev Winning outcome; meaningful only once status == Resolved.
    uint256 private _winningOutcome;

    /// @dev Total staked per outcome.
    mapping(uint256 outcome => uint256 staked) private _stakedFor;
    /// @dev Stake of each account per outcome.
    mapping(address account => mapping(uint256 outcome => uint256 stake)) private _stakeOf;
    /// @dev True once an account has claimed (winner share or void refund).
    mapping(address account => bool claimed) private _claimed;

    /// @dev Reentrancy lock: 1 = not entered, 2 = entered (storage-based; see PredictionMarket).
    ///      Set to 1 in {initialize}.
    uint256 private _entered;

    /// @dev Restricts a call to the controlling factory.
    modifier onlyController() {
        if (msg.sender != controller) revert NotController();
        _;
    }

    /// @dev Blocks reentrant entry into value-moving functions.
    modifier nonReentrant() {
        if (_entered == 2) revert Reentrancy();
        _entered = 2;
        _;
        _entered = 1;
    }

    /// @dev The implementation contract can never be initialized directly (only its clones).
    constructor() {
        _disableInitializers();
    }

    /// @inheritdoc IPredictionPool
    function initialize(address controller_, address treasury_, MarketParams calldata params) external initializer {
        if (controller_ == address(0) || treasury_ == address(0) || params.creator == address(0)) {
            revert ZeroAddress();
        }
        uint256 n = params.outcomeNames.length;
        if (n < 2 || n > MAX_OUTCOMES) revert InvalidOutcomeCount();
        if (params.feeBps > MAX_FEE_BPS || params.protocolFeeShareBps > FeeMath.BPS) revert InvalidFee();
        if (!(block.timestamp < params.lockTime && params.lockTime <= params.resolveTime)) {
            revert InvalidTiming();
        }

        _entered = 1;

        controller = controller_;
        treasury = treasury_;
        title = params.title;
        description = params.description;
        category = params.category;
        imageURI = params.imageURI;
        creator = params.creator;
        createdAt = uint64(block.timestamp);
        lockTime = params.lockTime;
        resolveTime = params.resolveTime;
        feeBps = params.feeBps;
        protocolFeeShareBps = params.protocolFeeShareBps;
        outcomeCount = n;
        status = MarketStatus.Open;

        for (uint256 i = 0; i < n; ++i) {
            _outcomeNames.push(params.outcomeNames[i]);
        }
    }

    // ----------------------------------------------------------------------------------------
    // Lifecycle (controller only)
    // ----------------------------------------------------------------------------------------

    /// @inheritdoc IPredictionPool
    function pause() external onlyController {
        if (status != MarketStatus.Open) revert MarketNotOpen();
        status = MarketStatus.Paused;
        emit MarketPaused(address(this));
    }

    /// @inheritdoc IPredictionPool
    function unpause() external onlyController {
        if (status != MarketStatus.Paused) revert MarketNotOpen();
        status = MarketStatus.Open;
        emit MarketUnpaused(address(this));
    }

    /// @inheritdoc IPredictionPool
    function close() external onlyController {
        _requireNotEnded();
        status = MarketStatus.Closed;
        emit MarketClosed(address(this));
    }

    /**
     * @notice Declares the winning outcome once betting has locked. Takes the house fee off
     *         the pool and forwards it to the treasury; the remainder becomes claimable,
     *         shared pro-rata among the winning outcome's backers.
     * @dev Deliberately stricter than the CPMM's resolve: the pool cannot be settled early,
     *      because every late bet would change everyone's payout.
     */
    function resolve(uint256 winningOutcome_) external onlyController nonReentrant {
        _requireNotEnded();
        if (block.timestamp < lockTime) revert LockNotReached();
        if (winningOutcome_ >= outcomeCount) revert InvalidOutcome();

        _winningOutcome = winningOutcome_;
        status = MarketStatus.Resolved;

        uint256 pool = totalPool;
        uint256 fee = (pool * feeBps) / FeeMath.BPS;
        _distributable = pool - fee;

        if (fee > 0) {
            IPredictionTreasury(treasury).depositFee{ value: fee }(address(this));
        }
        emit MarketResolved(address(this), winningOutcome_);
    }

    /// @inheritdoc IPredictionPool
    function voidMarket() external onlyController {
        _requireNotEnded();
        status = MarketStatus.Voided;
        emit MarketVoided(address(this));
    }

    /// @inheritdoc IPredictionPool
    function setTreasury(address treasury_) external onlyController {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
    }

    // ----------------------------------------------------------------------------------------
    // Betting
    // ----------------------------------------------------------------------------------------

    /**
     * @notice Bets the attached native collateral on `outcomeIndex`.
     * @param outcomeIndex Outcome to back.
     * @return staked The amount recorded for the caller.
     */
    function bet(uint256 outcomeIndex) external payable nonReentrant returns (uint256 staked) {
        if (status != MarketStatus.Open) revert MarketNotOpen();
        if (block.timestamp >= lockTime) revert TradingLocked();
        if (outcomeIndex >= outcomeCount) revert InvalidOutcome();
        staked = msg.value;
        if (staked == 0) revert ZeroAmount();

        // Effects only — no external call is made, but the guard costs little and keeps every
        // money path uniform.
        _stakeOf[msg.sender][outcomeIndex] += staked;
        _stakedFor[outcomeIndex] += staked;
        totalPool += staked;

        emit BetPlaced(address(this), msg.sender, outcomeIndex, staked);
    }

    // ----------------------------------------------------------------------------------------
    // Redemption
    // ----------------------------------------------------------------------------------------

    /**
     * @notice Claims the caller's payout. After resolution: their pro-rata slice of the pool
     *         net of fee, based on how much they staked on the winner. After a void: their
     *         full original stake back across all outcomes, fee-free.
     * @return payout Collateral paid to the caller.
     */
    function claim() external nonReentrant returns (uint256 payout) {
        if (_claimed[msg.sender]) revert NothingToClaim();
        MarketStatus s = status;

        if (s == MarketStatus.Resolved) {
            uint256 win = _winningOutcome;
            uint256 mine = _stakeOf[msg.sender][win];
            uint256 total = _stakedFor[win];
            if (mine == 0) revert NothingToClaim();
            payout = (mine * _distributable) / total;
        } else if (s == MarketStatus.Voided) {
            uint256 n = outcomeCount;
            for (uint256 j = 0; j < n; ++j) {
                payout += _stakeOf[msg.sender][j];
            }
            if (payout == 0) revert NothingToClaim();
        } else {
            revert MarketNotResolved();
        }

        _claimed[msg.sender] = true;
        _sendNative(msg.sender, payout);
        emit RewardClaimed(address(this), msg.sender, payout);
    }

    /// @notice Receives native collateral sent directly to the contract. Reverts to prevent
    ///         accidental sends — use {bet} to place a wager.
    receive() external payable {
        revert ZeroAmount();
    }

    /// @notice Fallback for any unmatched call. Reverts to prevent accidental interactions.
    fallback() external payable {
        revert ZeroAmount();
    }

    // ----------------------------------------------------------------------------------------
    // Views
    // ----------------------------------------------------------------------------------------

    /// @inheritdoc IPredictionPool
    function winningOutcome() external view returns (uint256) {
        if (status != MarketStatus.Resolved) revert MarketNotResolved();
        return _winningOutcome;
    }

    /// @notice Total collateral bet on `outcomeIndex`.
    function stakedFor(uint256 outcomeIndex) external view returns (uint256) {
        if (outcomeIndex >= outcomeCount) revert InvalidOutcome();
        return _stakedFor[outcomeIndex];
    }

    /// @notice The caller's current stake on `outcomeIndex`.
    function myStake(uint256 outcomeIndex) external view returns (uint256) {
        if (outcomeIndex >= outcomeCount) revert InvalidOutcome();
        return _stakeOf[msg.sender][outcomeIndex];
    }

    /// @notice Collateral available to winners after the resolution fee.
    function distributableAmount() external view returns (uint256) {
        return _distributable;
    }

    /**
     * @notice What the caller would receive if the market resolved right now to
     *         `outcomeIndex` (pool minus fee, times their stake share). Informational: the
     *         real pool grows until `lockTime`, and resolution itself fixes the numbers.
     */
    function previewPayout(uint256 outcomeIndex) external view returns (uint256) {
        if (outcomeIndex >= outcomeCount) revert InvalidOutcome();
        uint256 pool = totalPool;
        uint256 fee = (pool * feeBps) / FeeMath.BPS;
        uint256 total = _stakedFor[outcomeIndex];
        if (total == 0) {
            return 0;
        }
        return (_stakeOf[msg.sender][outcomeIndex] * (pool - fee)) / total;
    }

    /// @notice Implied odds of `outcomeIndex`: its stake as a fraction of the whole pool (WAD).
    function impliedOdds(uint256 outcomeIndex) external view returns (uint256) {
        if (outcomeIndex >= outcomeCount) revert InvalidOutcome();
        uint256 pool = totalPool;
        if (pool == 0) {
            return 0;
        }
        return (_stakedFor[outcomeIndex] * 1e18) / pool;
    }

    /// @inheritdoc IPredictionPool
    function outcomeName(uint256 outcomeIndex) external view returns (string memory) {
        if (outcomeIndex >= outcomeCount) revert InvalidOutcome();
        return _outcomeNames[outcomeIndex];
    }

    // ----------------------------------------------------------------------------------------
    // Internal
    // ----------------------------------------------------------------------------------------

    /// @dev Reverts if the market has already reached a terminal status.
    function _requireNotEnded() private view {
        if (status == MarketStatus.Resolved || status == MarketStatus.Voided) revert MarketAlreadyEnded();
    }

    /// @dev Native transfer with an explicit success check.
    function _sendNative(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
