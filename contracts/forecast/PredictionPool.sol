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
    ClaimWindowOpen,
    ClaimWindowClosed,
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
    MarketVoided,
    UnclaimedSwept,
    PayoutDeferred,
    DistributionAdvanced,
    AutoDistributeSet
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
 * @dev Bets are plain deposits accounted per (user, outcome); nothing is minted. Settlement
 *      can pay bettors out by itself: with {autoDistribute} switched on, {resolve} and
 *      {voidMarket} push the first {AUTO_DISTRIBUTE_BATCH} payouts in the same transaction,
 *      and anyone can carry the rest with {distribute}. That push is off until an admin asks
 *      for it ({setAutoDistribute}), and it is never the only way out either way, because
 *      {distribute} is permissionless and {claim} always lets a bettor collect their own
 *      share. Payment stays one-shot per account (`_claimed` flag), so nobody can be paid
 *      twice. Resolution cannot happen before `lockTime` — the pool must be closed to
 *      new money before a winner can be declared. Rounding floors every payout; the sub-unit
 *      dust stays in the contract. `params.protocolFeeShareBps` is ignored here: the full fee
 *      goes to the treasury, because there are no LPs to retain the rest for.
 */
contract PredictionPool is IPredictionPool, Initializable {
    /// @notice Maximum supported outcomes (bounds every per-outcome loop).
    uint256 public constant MAX_OUTCOMES = 16;

    /// @notice Maximum total fee (10%).
    uint16 public constant MAX_FEE_BPS = 1000;

    /// @notice How long winners keep the right to claim after the pool settles. Once it
    ///         elapses the leftover collateral is sweepable to the treasury.
    uint64 public constant CLAIM_WINDOW = 365 days;

    /// @notice Payouts pushed inside the settlement transaction itself. Small pools are
    ///         therefore paid out in full the moment an admin resolves or voids them;
    ///         anything larger is carried by {distribute} calls afterwards.
    uint256 public constant AUTO_DISTRIBUTE_BATCH = 20;

    /// @dev Gas forwarded to each pushed payout. Enough for an ordinary wallet or a plain
    ///      `receive()`, and low enough that one hostile recipient cannot burn the batch.
    ///      Whatever it cannot deliver becomes a pullable credit, so nobody loses money.
    uint256 private constant PUSH_GAS = 50_000;

    /// @notice The factory; the only address allowed to drive lifecycle actions.
    address public controller;

    /// @notice Treasury that receives the resolution fee.
    address public treasury;

    /// @notice Current lifecycle status.
    MarketStatus public status;

    /// @notice Whether settlement pushes the first batch of payouts by itself. Off until an
    ///         admin turns it on, so a market pays out on request unless someone has decided
    ///         it should pay out on its own. It never gates the money either way:
    ///         {distribute} is open to anyone, and a participant can always collect their
    ///         own share.
    bool public autoDistribute;

    /// @notice Human-readable market metadata.
    string public title;
    string public description;
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
    /// @notice Category this market is filed under, in the factory's registry. The name a
    ///         reader sees is looked up there, per language.
    uint32 public categoryId;
    /// @notice When the pool settled (Resolved or Voided); 0 while it is still live. The
    ///         claim window runs for {CLAIM_WINDOW} from this instant.
    uint64 public endedAt;

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
    /// @dev True once an account has been paid (pushed or pulled), or had nothing coming.
    mapping(address account => bool claimed) private _claimed;

    /// @dev Every account that has ever bet, in first-bet order. The distribution walks it.
    address[] private _participants;
    /// @dev Stake of each account across all outcomes; doubles as the void-refund amount and
    ///      as the "is this a first bet?" test that keeps `_participants` free of duplicates.
    mapping(address account => uint256 staked) private _totalStakeOf;
    /// @dev How far the push has walked `_participants`.
    uint256 private _cursor;
    /// @dev Payouts a push could not deliver, waiting to be pulled by {claim}.
    mapping(address account => uint256 amount) private _credited;

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
        categoryId = params.categoryId;
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
        endedAt = uint64(block.timestamp);

        uint256 pool = totalPool;
        uint256 fee = (pool * feeBps) / FeeMath.BPS;
        _distributable = pool - fee;

        if (fee > 0) {
            IPredictionTreasury(treasury).depositFee{ value: fee }(address(this));
        }
        emit MarketResolved(address(this), winningOutcome_);

        // Winners do not have to come and ask: start paying them right here, unless an admin
        // has turned that off for this market.
        if (autoDistribute) {
            _pushPayouts(AUTO_DISTRIBUTE_BATCH);
        }
    }

    /// @inheritdoc IPredictionPool
    function voidMarket() external onlyController nonReentrant {
        _requireNotEnded();
        status = MarketStatus.Voided;
        endedAt = uint64(block.timestamp);
        emit MarketVoided(address(this));

        // Refunds go back out on their own, exactly like winnings do.
        if (autoDistribute) {
            _pushPayouts(AUTO_DISTRIBUTE_BATCH);
        }
    }

    /// @inheritdoc IPredictionPool
    function setTreasury(address treasury_) external onlyController {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
    }

    /// @inheritdoc IPredictionPool
    function setAutoDistribute(bool enabled) external onlyController {
        autoDistribute = enabled;
        emit AutoDistributeSet(address(this), enabled);
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
        if (_totalStakeOf[msg.sender] == 0) {
            _participants.push(msg.sender);
        }
        _totalStakeOf[msg.sender] += staked;
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
        _requireClaimWindowOpen();

        uint256 credit = _credited[msg.sender];
        if (credit > 0) {
            // A push already set this money aside; it just could not be delivered.
            _credited[msg.sender] = 0;
            payout = credit;
        } else {
            if (_claimed[msg.sender]) revert NothingToClaim();
            MarketStatus s = status;
            if (s != MarketStatus.Resolved && s != MarketStatus.Voided) revert MarketNotResolved();
            payout = _payoutOf(msg.sender);
            if (payout == 0) revert NothingToClaim();
            _claimed[msg.sender] = true;
        }

        _sendNative(msg.sender, payout);
        emit RewardClaimed(address(this), msg.sender, payout);
    }

    // ----------------------------------------------------------------------------------------
    // Automatic distribution
    // ----------------------------------------------------------------------------------------

    /// @inheritdoc IPredictionPool
    function distribute(uint256 limit) external nonReentrant returns (uint256 paid) {
        if (endedAt == 0) revert MarketNotResolved();
        if (limit == 0) revert ZeroAmount();
        _requireClaimWindowOpen();
        paid = _pushPayouts(limit);
    }

    // ----------------------------------------------------------------------------------------
    // Residue sweep
    // ----------------------------------------------------------------------------------------

    /// @inheritdoc IPredictionPool
    function sweepUnclaimed() external onlyController nonReentrant returns (uint256 amount) {
        uint64 deadline = claimDeadline();
        if (deadline == 0) revert MarketNotResolved();
        if (block.timestamp < deadline) revert ClaimWindowOpen();

        // Everything still here: unclaimed winner shares, void refunds nobody came back for,
        // and the sub-unit rounding dust every pro-rata payout leaves behind.
        amount = address(this).balance;
        if (amount == 0) revert ZeroAmount();

        // Effects: nothing is distributable any more and {claim} is already shut by the deadline.
        _distributable = 0;

        address to = treasury;
        IPredictionTreasury(to).depositFee{ value: amount }(address(this));
        emit UnclaimedSwept(address(this), to, amount);
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
    function claimDeadline() public view returns (uint64) {
        uint64 ended = endedAt;
        return ended == 0 ? 0 : ended + CLAIM_WINDOW;
    }

    /// @inheritdoc IPredictionPool
    function distributionProgress() external view returns (uint256 cursor, uint256 total) {
        return (_cursor, _participants.length);
    }

    /// @inheritdoc IPredictionPool
    function pendingPayout(address account) external view returns (uint256) {
        uint256 credit = _credited[account];
        if (credit > 0) {
            return credit;
        }
        if (_claimed[account] || endedAt == 0) {
            return 0;
        }
        return _payoutOf(account);
    }

    /// @notice Total accounts that have ever bet on this pool (the distribution's length).
    function participantCount() external view returns (uint256) {
        return _participants.length;
    }

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

    /// @dev Reverts once the claim window has elapsed. The cut-off is the deadline itself,
    ///      not the sweep transaction, so claiming stops at the same instant for everyone
    ///      whether or not an admin has already collected the residue.
    function _requireClaimWindowOpen() private view {
        uint64 deadline = claimDeadline();
        if (deadline != 0 && block.timestamp >= deadline) revert ClaimWindowClosed();
    }

    /// @dev What `account` is owed at the current settlement, before any payment. Returns 0
    ///      for a losing bettor, and for a winning outcome nobody backed (the pool then has
    ///      no one to pay; {sweepUnclaimed} recovers it a year on).
    function _payoutOf(address account) private view returns (uint256) {
        if (status == MarketStatus.Resolved) {
            uint256 win = _winningOutcome;
            uint256 total = _stakedFor[win];
            if (total == 0) {
                return 0;
            }
            return (_stakeOf[account][win] * _distributable) / total;
        }
        // Voided: every bettor gets their own stake back, fee-free.
        return _totalStakeOf[account];
    }

    /// @dev Pays up to `limit` further participants and advances the cursor. Each account is
    ///      marked paid before its transfer, and a transfer that fails becomes a credit
    ///      rather than a revert, so one recipient can never stall the queue behind it.
    function _pushPayouts(uint256 limit) private returns (uint256 paid) {
        uint256 i = _cursor;
        uint256 total = _participants.length;
        uint256 end = i + limit;
        if (end > total) {
            end = total;
        }

        for (; i < end; ++i) {
            address account = _participants[i];
            if (_claimed[account]) {
                continue;
            }
            uint256 payout = _payoutOf(account);
            _claimed[account] = true;
            if (payout == 0) {
                continue;
            }
            (bool ok, ) = payable(account).call{ value: payout, gas: PUSH_GAS }("");
            if (ok) {
                paid += payout;
                emit RewardClaimed(address(this), account, payout);
            } else {
                _credited[account] += payout;
                emit PayoutDeferred(address(this), account, payout);
            }
        }

        _cursor = i;
        emit DistributionAdvanced(address(this), i, total, paid);
    }

    /// @dev Native transfer with an explicit success check.
    function _sendNative(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
