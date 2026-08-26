// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";
import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import { IPredictionFactory } from "./interfaces/IPredictionFactory.sol";
import { IPredictionMarket } from "./interfaces/IPredictionMarket.sol";
import { MarketKind, MarketStatus, MarketParams, MarketRecord } from "./PredictionTypes.sol";
import {
    ZeroAddress,
    InvalidFee,
    InvalidOutcome,
    MarketAlreadyEnded,
    NotSigner,
    NotOwner,
    DuplicateSigner,
    BadQuorum
} from "./PredictionErrors.sol";
import {
    MarketCreated,
    TreasuryUpdated,
    FeesUpdated,
    ResolutionConfirmed,
    ResolutionExecuted,
    ResolutionSignersUpdated
} from "./PredictionEvents.sol";

/**
 * @title PredictionFactory
 * @notice Deploys prediction markets as EIP-1167 clones of a single implementation, keeps the
 *         canonical registry, and is the admin control plane every market trusts as its
 *         controller. Lifecycle actions (pause/close/resolve/void) go through the factory so
 *         the registry's per-market status stays authoritative and listings never have to
 *         cross-call the clones.
 */
contract PredictionFactory is IPredictionFactory, AccessControl {
    using EnumerableSet for EnumerableSet.UintSet;

    /// @notice Role permitted to create and administer markets.
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    /// @notice Basis-point denominator.
    uint16 public constant BPS = 1e4;
    /// @notice Maximum total trade fee (10%).
    uint16 public constant MAX_FEE_BPS = 1000;

    /// @notice Maximum number of resolution signers the owner can appoint (bounds loops/gas).
    uint256 public constant MAX_SIGNERS = 10;

    /// @notice The market implementation cloned for every new market.
    address public immutable marketImplementation;

    /// @notice The parimutuel implementation cloned by {createMarket2}.
    address public immutable poolImplementation;

    /// @notice Treasury applied to new markets.
    address private _treasury;

    /// @notice Default total fee (bps) applied when a market requests 0.
    uint16 public defaultFeeBps;
    /// @notice Default protocol fee share (bps) applied when a market requests 0.
    uint16 public defaultProtocolFeeShareBps;

    /// @dev Registry of every market, indexed by marketId.
    MarketRecord[] private _records;
    /// @dev Which engine each market runs on.
    mapping(uint256 marketId => MarketKind kind) private _kinds;
    /// @dev marketId sets bucketed by current status (for O(1) transitions + paged filters).
    mapping(MarketStatus => EnumerableSet.UintSet) private _byStatus;

    /// @notice The account allowed to appoint/remove resolution signers and set the quorum.
    address public owner;

    /// @notice The resolution signer set (multisig "M"); ordered, unique, non-zero.
    address[] private _signers;
    /// @dev Fast membership test for `_signers`.
    mapping(address account => bool signer) private _isSigner;
    /// @dev Distinct confirmations needed on one outcome before a market resolves.
    uint256 private _required;
    /// @dev Per-market vote ledger: marketId → signer → outcome voted **plus one**
    ///      (storage zero means "no vote yet", so outcome 0 is distinguishable from abstained).
    mapping(uint256 marketId => mapping(address signer => uint256 outcomePlusOne)) private _voteOf;
    /// @dev Per-market tallies: marketId → outcome → distinct signers currently voting it.
    mapping(uint256 marketId => mapping(uint256 outcome => uint256 count)) private _tally;

    /**
     * @param admin Address granted DEFAULT_ADMIN_ROLE and ADMIN_ROLE (market creation and
     *        lifecycle other than resolution).
     * @param treasury_ Treasury for protocol fees.
     * @param marketImplementation_ Deployed {PredictionMarket} implementation to clone.
     * @param poolImplementation_ Deployed {PredictionPool} implementation to clone.
     * @param defaultFeeBps_ Default trade fee (bps).
     * @param defaultProtocolFeeShareBps_ Default protocol share of fees (bps).
     * @param owner_ Account allowed to re-appoint the resolution signers and quorum. Zero
     *        means "same as admin".
     * @param initialSigners_ The N-of-M resolution signer set. Resolving a market needs
     *        `requiredConfirmations` of these to agree on one outcome; production wants
     *        five signers with a threshold of three.
     * @param requiredConfirmations_ Initial quorum: 1 <= n <= initialSigners_.length.
     */
    constructor(
        address admin,
        address treasury_,
        address marketImplementation_,
        address poolImplementation_,
        uint16 defaultFeeBps_,
        uint16 defaultProtocolFeeShareBps_,
        address owner_,
        address[] memory initialSigners_,
        uint256 requiredConfirmations_
    ) {
        if (
            admin == address(0) || treasury_ == address(0) || marketImplementation_ == address(0)
                || poolImplementation_ == address(0)
        ) {
            revert ZeroAddress();
        }
        if (defaultFeeBps_ > MAX_FEE_BPS || defaultProtocolFeeShareBps_ > BPS) revert InvalidFee();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
        _treasury = treasury_;
        marketImplementation = marketImplementation_;
        poolImplementation = poolImplementation_;
        defaultFeeBps = defaultFeeBps_;
        defaultProtocolFeeShareBps = defaultProtocolFeeShareBps_;

        owner = owner_ == address(0) ? admin : owner_;

        // An empty signer list is a convenience for first deploys: the admin becomes the
        // sole signer (quorum effectively 1). Production passes real distinct addresses
        // and an explicit threshold instead.
        if (initialSigners_.length == 0) {
            if (requiredConfirmations_ > 1) revert BadQuorum();
            _addSigner(admin);
            _required = requiredConfirmations_ == 0 ? 1 : requiredConfirmations_;
        } else {
            if (initialSigners_.length > MAX_SIGNERS) revert BadQuorum();
            for (uint256 i = 0; i < initialSigners_.length; ++i) {
                _addSigner(initialSigners_[i]);
            }
            if (requiredConfirmations_ == 0 || requiredConfirmations_ > _signers.length) {
                revert BadQuorum();
            }
            _required = requiredConfirmations_;
        }
    }

    // ----------------------------------------------------------------------------------------
    // Admin actions
    // ----------------------------------------------------------------------------------------

    /// @dev Restricts a call to the factory owner (signer-set and quorum management).
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @dev Restricts a call to appointed resolution signers.
    modifier onlySigner() {
        if (!_isSigner[msg.sender]) revert NotSigner();
        _;
    }

    /// @inheritdoc IPredictionFactory
    function createMarket(MarketParams calldata params)
        external
        payable
        onlyRole(ADMIN_ROLE)
        returns (uint256 marketId, address market)
    {
        // A market requesting 0 fees inherits the factory defaults; explicit values pass through.
        MarketParams memory effective = params;
        if (effective.feeBps == 0) {
            effective.feeBps = defaultFeeBps;
        }
        if (effective.protocolFeeShareBps == 0) {
            effective.protocolFeeShareBps = defaultProtocolFeeShareBps;
        }

        market = Clones.clone(marketImplementation);
        IPredictionMarket(market).initialize{ value: msg.value }(address(this), _treasury, effective);

        marketId = _records.length;
        _records.push(
            MarketRecord({
                market: market,
                creator: effective.creator,
                title: effective.title,
                category: effective.category,
                status: MarketStatus.Open,
                createdAt: uint64(block.timestamp),
                lockTime: effective.lockTime,
                resolveTime: effective.resolveTime,
                outcomeCount: uint32(effective.outcomeNames.length)
            })
        );
        _byStatus[MarketStatus.Open].add(marketId);

        emit MarketCreated(
            marketId, market, effective.creator, effective.category, effective.outcomeNames.length, msg.value
        );
    }

    /**
     * @notice Deploys a new parimutuel {PredictionPool} market. Betting runs until
     *         `params.lockTime`; afterwards an admin resolves the winner, the house fee is
     *         taken off the pool once, and the remainder is shared pro-rata among the winning
     *         outcome's backers.
     * @dev Not payable on purpose: a pool needs no seed liquidity, so attached value would be
     *      unrecoverable — fail loudly instead. A `feeBps` of 0 inherits the factory default,
     *      which is how a fee percentage gets matched to the market's type/category; the pool
     *      ignores `protocolFeeShareBps` (there are no LPs).
     * @param params Market configuration.
     * @return marketId The market's registry index.
     * @return market The deployed clone address.
     */
    function createMarket2(MarketParams calldata params)
        external
        onlyRole(ADMIN_ROLE)
        returns (uint256 marketId, address market)
    {
        MarketParams memory effective = params;
        if (effective.feeBps == 0) {
            effective.feeBps = defaultFeeBps;
        }

        market = Clones.clone(poolImplementation);
        IPredictionMarket(market).initialize(address(this), _treasury, effective);

        marketId = _records.length;
        _kinds[marketId] = MarketKind.Pool;
        _records.push(
            MarketRecord({
                market: market,
                creator: effective.creator,
                title: effective.title,
                category: effective.category,
                status: MarketStatus.Open,
                createdAt: uint64(block.timestamp),
                lockTime: effective.lockTime,
                resolveTime: effective.resolveTime,
                outcomeCount: uint32(effective.outcomeNames.length)
            })
        );
        _byStatus[MarketStatus.Open].add(marketId);

        emit MarketCreated(marketId, market, effective.creator, effective.category, effective.outcomeNames.length, 0);
    }

    /// @inheritdoc IPredictionFactory
    function pauseMarket(uint256 marketId) external onlyRole(ADMIN_ROLE) {
        IPredictionMarket(_records[marketId].market).pause();
        _setStatus(marketId, MarketStatus.Paused);
    }

    /// @inheritdoc IPredictionFactory
    function unpauseMarket(uint256 marketId) external onlyRole(ADMIN_ROLE) {
        IPredictionMarket(_records[marketId].market).unpause();
        _setStatus(marketId, MarketStatus.Open);
    }

    /// @inheritdoc IPredictionFactory
    function closeMarket(uint256 marketId) external onlyRole(ADMIN_ROLE) {
        IPredictionMarket(_records[marketId].market).close();
        _setStatus(marketId, MarketStatus.Closed);
    }

    /**
     * @notice Casts a resolution signer's vote for a market's winning outcome. The moment
     *         any single outcome holds `_required` distinct votes, the market is resolved
     *         on-chain in this same transaction: the clone's `resolve` runs (which takes the
     *         house fee and, on pool markets, unlocks winner claims), the registry flips to
     *         Resolved, and {ResolutionExecuted} is emitted.
     * @dev One open vote per signer per market; voting a different outcome before quorum
     *      moves the tally. Votes are never cleared after execution — a terminal market can
     *      no longer be re-resolved because the clone's `_requireNotEnded` reverts.
     * @param marketId Market to resolve.
     * @param winningOutcome Outcome being confirmed.
     */
    function confirmResolution(uint256 marketId, uint256 winningOutcome) external onlySigner {
        MarketRecord storage record = _records[marketId];
        if (_isEnded(record.status)) revert MarketAlreadyEnded();
        if (winningOutcome >= record.outcomeCount) revert InvalidOutcome();

        uint256 stored = _voteOf[marketId][msg.sender];
        // Stored zero means "no vote yet"; otherwise the field carries outcome + 1.
        uint256 previous = stored == 0 ? type(uint256).max : stored - 1;
        if (previous != winningOutcome) {
            // Move the signer's vote (the sentinel branch skips the decrement for first-timers).
            if (previous != type(uint256).max && _tally[marketId][previous] > 0) {
                unchecked {
                    _tally[marketId][previous] -= 1;
                }
            }
            _voteOf[marketId][msg.sender] = winningOutcome + 1;
            uint256 count = _tally[marketId][winningOutcome] + 1;
            _tally[marketId][winningOutcome] = count;

            emit ResolutionConfirmed(marketId, msg.sender, winningOutcome, count);
            if (count < _required) return;
        }

        // Quorum reached (or the last needed signer re-affirmed the leading outcome).
        IPredictionMarket(record.market).resolve(winningOutcome);
        _setStatus(marketId, MarketStatus.Resolved);
        emit ResolutionExecuted(marketId, winningOutcome, _tally[marketId][winningOutcome]);
    }

    /**
     * @notice Replaces the resolution signer set and quorum in one shot.
     * @dev Owner-only. Passing an empty array or a quorum of zero/over-length reverts, so
     *      resolution can never be bricked into "impossible" by configuration.
     * @param signers New signer set (unique, non-zero, <= MAX_SIGNERS entries).
     * @param required New threshold: 1 <= required <= signers.length.
     */
    function setResolutionSigners(address[] calldata signers, uint256 required) external onlyOwner {
        if (signers.length == 0 || signers.length > MAX_SIGNERS) revert BadQuorum();

        // Wipe the old membership map first so stale entries cannot linger.
        address[] memory old = _signers;
        for (uint256 i = 0; i < old.length; ++i) {
            _isSigner[old[i]] = false;
        }
        delete _signers;

        for (uint256 i = 0; i < signers.length; ++i) {
            _addSigner(signers[i]);
        }
        if (required == 0 || required > _signers.length) revert BadQuorum();
        _required = required;

        emit ResolutionSignersUpdated(signers, required);
    }

    /// @notice Which addresses may confirm resolutions (ordered as stored).
    function resolutionSigners() external view returns (address[] memory) {
        return _signers;
    }

    /// @notice True when `account` may call {confirmResolution}.
    function isResolutionSigner(address account) external view returns (bool) {
        return _isSigner[account];
    }

    /// @notice Distinct votes needed on one outcome before a market resolves.
    function requiredConfirmations() external view returns (uint256) {
        return _required;
    }

    /// @notice Current distinct-vote tally for `outcome` on `marketId`.
    function confirmationCount(uint256 marketId, uint256 outcome) external view returns (uint256) {
        return _tally[marketId][outcome];
    }

    /// @notice The outcome `signer` voted for on `marketId`, or `type(uint256).max` for none.
    function confirmationOf(uint256 marketId, address signer) external view returns (uint256) {
        uint256 stored = _voteOf[marketId][signer];
        return stored == 0 ? type(uint256).max : stored - 1;
    }

    /// @inheritdoc IPredictionFactory
    function voidMarket(uint256 marketId) external onlyRole(ADMIN_ROLE) {
        IPredictionMarket(_records[marketId].market).voidMarket();
        _setStatus(marketId, MarketStatus.Voided);
    }

    /// @inheritdoc IPredictionFactory
    function setTreasury(address treasury_) external onlyRole(ADMIN_ROLE) {
        if (treasury_ == address(0)) revert ZeroAddress();
        _treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    /**
     * @notice Re-points an existing market's treasury to the factory's current one.
     * @dev Per-market (not a loop over all markets) so gas stays bounded.
     * @param marketId Market to update.
     */
    function repointTreasury(uint256 marketId) external onlyRole(ADMIN_ROLE) {
        IPredictionMarket(_records[marketId].market).setTreasury(_treasury);
    }

    /// @inheritdoc IPredictionFactory
    function setDefaultFees(uint16 feeBps, uint16 protocolFeeShareBps) external onlyRole(ADMIN_ROLE) {
        if (feeBps > MAX_FEE_BPS || protocolFeeShareBps > BPS) revert InvalidFee();
        defaultFeeBps = feeBps;
        defaultProtocolFeeShareBps = protocolFeeShareBps;
        emit FeesUpdated(feeBps, protocolFeeShareBps);
    }

    // ----------------------------------------------------------------------------------------
    // Registry views
    // ----------------------------------------------------------------------------------------

    /// @inheritdoc IPredictionFactory
    function marketCount() external view returns (uint256) {
        return _records.length;
    }

    /// @inheritdoc IPredictionFactory
    function marketAt(uint256 marketId) external view returns (MarketRecord memory) {
        return _records[marketId];
    }

    /// @inheritdoc IPredictionFactory
    function marketAddress(uint256 marketId) external view returns (address) {
        return _records[marketId].market;
    }

    /// @notice Which engine a market runs on (AMM shares vs parimutuel pool).
    function marketKind(uint256 marketId) external view returns (MarketKind) {
        return _kinds[marketId];
    }

    /// @inheritdoc IPredictionFactory
    function treasury() external view returns (address) {
        return _treasury;
    }

    /// @inheritdoc IPredictionFactory
    function marketsPaged(uint256 offset, uint256 limit) external view returns (MarketRecord[] memory page) {
        uint256 total = _records.length;
        if (offset >= total) {
            return new MarketRecord[](0);
        }
        uint256 end = offset + limit;
        if (end > total) {
            end = total;
        }
        page = new MarketRecord[](end - offset);
        for (uint256 i = offset; i < end; ++i) {
            page[i - offset] = _records[i];
        }
    }

    /// @inheritdoc IPredictionFactory
    function marketsByStatus(MarketStatus status, uint256 offset, uint256 limit)
        public
        view
        returns (MarketRecord[] memory page)
    {
        EnumerableSet.UintSet storage ids = _byStatus[status];
        uint256 total = ids.length();
        if (offset >= total) {
            return new MarketRecord[](0);
        }
        uint256 end = offset + limit;
        if (end > total) {
            end = total;
        }
        page = new MarketRecord[](end - offset);
        for (uint256 i = offset; i < end; ++i) {
            page[i - offset] = _records[ids.at(i)];
        }
    }

    /// @inheritdoc IPredictionFactory
    function activeMarkets(uint256 offset, uint256 limit) external view returns (MarketRecord[] memory) {
        return marketsByStatus(MarketStatus.Open, offset, limit);
    }

    /// @inheritdoc IPredictionFactory
    function closedMarkets(uint256 offset, uint256 limit) external view returns (MarketRecord[] memory) {
        return marketsByStatus(MarketStatus.Closed, offset, limit);
    }

    /// @inheritdoc IPredictionFactory
    function resolvedMarkets(uint256 offset, uint256 limit) external view returns (MarketRecord[] memory) {
        return marketsByStatus(MarketStatus.Resolved, offset, limit);
    }

    /// @notice Number of markets currently in `status`.
    function countByStatus(MarketStatus status) external view returns (uint256) {
        return _byStatus[status].length();
    }

    // ----------------------------------------------------------------------------------------
    // Internal
    // ----------------------------------------------------------------------------------------

    /// @dev Moves a market between status buckets and updates its record.
    function _setStatus(uint256 marketId, MarketStatus next) private {
        MarketStatus prev = _records[marketId].status;
        if (prev == next) {
            return;
        }
        _byStatus[prev].remove(marketId);
        _byStatus[next].add(marketId);
        _records[marketId].status = next;
    }

    /// @dev True once a market has reached a terminal status (mirror of the clones' rule).
    function _isEnded(MarketStatus status_) private pure returns (bool) {
        return status_ == MarketStatus.Resolved || status_ == MarketStatus.Voided;
    }

    /// @dev Appends one validated signer; reverts on zero or duplicate addresses.
    function _addSigner(address signer) private {
        if (signer == address(0)) revert ZeroAddress();
        if (_isSigner[signer]) revert DuplicateSigner();
        _isSigner[signer] = true;
        _signers.push(signer);
    }
}
