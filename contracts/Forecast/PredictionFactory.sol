// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";
import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import { IPredictionFactory } from "./interfaces/IPredictionFactory.sol";
import { IPredictionMarket } from "./interfaces/IPredictionMarket.sol";
import { MarketStatus, MarketParams, MarketRecord } from "./PredictionTypes.sol";
import { ZeroAddress, InvalidFee } from "./PredictionErrors.sol";
import { MarketCreated, TreasuryUpdated, FeesUpdated } from "./PredictionEvents.sol";

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

    /// @notice The market implementation cloned for every new market.
    address public immutable marketImplementation;

    /// @notice Treasury applied to new markets.
    address private _treasury;

    /// @notice Default total fee (bps) applied when a market requests 0.
    uint16 public defaultFeeBps;
    /// @notice Default protocol fee share (bps) applied when a market requests 0.
    uint16 public defaultProtocolFeeShareBps;

    /// @dev Registry of every market, indexed by marketId.
    MarketRecord[] private _records;
    /// @dev marketId sets bucketed by current status (for O(1) transitions + paged filters).
    mapping(MarketStatus => EnumerableSet.UintSet) private _byStatus;

    /**
     * @param admin Address granted DEFAULT_ADMIN_ROLE and ADMIN_ROLE.
     * @param treasury_ Treasury for protocol fees.
     * @param marketImplementation_ Deployed {PredictionMarket} implementation to clone.
     * @param defaultFeeBps_ Default trade fee (bps).
     * @param defaultProtocolFeeShareBps_ Default protocol share of fees (bps).
     */
    constructor(
        address admin,
        address treasury_,
        address marketImplementation_,
        uint16 defaultFeeBps_,
        uint16 defaultProtocolFeeShareBps_
    ) {
        if (admin == address(0) || treasury_ == address(0) || marketImplementation_ == address(0)) {
            revert ZeroAddress();
        }
        if (defaultFeeBps_ > MAX_FEE_BPS || defaultProtocolFeeShareBps_ > BPS) revert InvalidFee();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
        _treasury = treasury_;
        marketImplementation = marketImplementation_;
        defaultFeeBps = defaultFeeBps_;
        defaultProtocolFeeShareBps = defaultProtocolFeeShareBps_;
    }

    // ----------------------------------------------------------------------------------------
    // Admin actions
    // ----------------------------------------------------------------------------------------

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

    /// @inheritdoc IPredictionFactory
    function resolveMarket(uint256 marketId, uint256 winningOutcome) external onlyRole(ADMIN_ROLE) {
        IPredictionMarket(_records[marketId].market).resolve(winningOutcome);
        _setStatus(marketId, MarketStatus.Resolved);
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
}
