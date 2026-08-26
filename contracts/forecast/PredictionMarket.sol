// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { ERC1155Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC1155/ERC1155Upgradeable.sol";
import {
    ERC1155SupplyUpgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC1155/extensions/ERC1155SupplyUpgradeable.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { IPredictionMarket } from "./interfaces/IPredictionMarket.sol";
import { IPredictionTreasury } from "./interfaces/IPredictionTreasury.sol";
import { MarketMath } from "./libraries/MarketMath.sol";
import { FeeMath } from "./libraries/FeeMath.sol";
import { MarketStatus, MarketParams } from "./PredictionTypes.sol";
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
    DeadlineExpired,
    SlippageExceeded,
    NothingToClaim,
    TransferFailed,
    Reentrancy
} from "./PredictionErrors.sol";
import {
    PredictionPlaced,
    PredictionSold,
    LiquidityAdded,
    LiquidityRemoved,
    RewardClaimed,
    MarketPaused,
    MarketUnpaused,
    MarketClosed,
    MarketResolved,
    MarketVoided
} from "./PredictionEvents.sol";

/**
 * @title PredictionMarket
 * @notice A single fixed-product (CPMM) prediction market. Deployed as an EIP-1167 clone by
 *         {PredictionFactory} and initialized once. Collateral is the chain's native token;
 *         each outcome is an ERC-1155 id (0..n-1) and liquidity providers hold the reserved
 *         {LP_TOKEN_ID}.
 *
 * @dev Reserves are tracked virtually in {_reserves}; the market is the sole issuer of outcome
 *      tokens, so it never has to custody them. The system's solvency rests on one invariant,
 *      maintained by every state transition and asserted in tests:
 *
 *          for every outcome i:  reserves[i] + totalUserSupply(i)  ==  totalSets  ==  collateral
 *
 *      A buy/sell/funding operation adds or removes the same amount from every outcome's total,
 *      so the equality across outcomes is preserved, and `totalSets` always equals the contract's
 *      native balance (protocol fees leave, LP fees are re-injected as liquidity). Winning shares
 *      therefore always redeem 1:1 without the pool going insolvent.
 */
contract PredictionMarket is IPredictionMarket, Initializable, ERC1155SupplyUpgradeable {
    /// @notice ERC-1155 id used for liquidity-provider shares (outcomes use ids 0..n-1).
    uint256 public constant LP_TOKEN_ID = type(uint256).max;

    /// @notice Maximum supported outcomes (bounds every per-outcome loop).
    uint256 public constant MAX_OUTCOMES = 16;

    /// @notice Maximum total trade fee (10%).
    uint16 public constant MAX_FEE_BPS = 1000;

    /// @notice The factory; the only address allowed to drive lifecycle actions.
    address public controller;

    /// @notice Treasury that receives protocol fees.
    address public treasury;

    /// @notice Current lifecycle status.
    MarketStatus public status;

    /// @notice Human-readable market metadata.
    string public title;
    string public description;
    string public category;
    string public imageURI;

    /// @notice Account credited as the market's creator/first LP.
    address public creator;

    /// @notice Creation timestamp.
    uint64 public createdAt;
    /// @notice Trading closes at this timestamp.
    uint64 public lockTime;
    /// @notice Intended resolution timestamp (informational; admin resolves).
    uint64 public resolveTime;

    /// @notice Total trade fee in basis points.
    uint16 public feeBps;
    /// @notice Protocol share of each fee in basis points (remainder accrues to LPs).
    uint16 public protocolFeeShareBps;

    /// @notice Number of outcomes.
    uint256 public outcomeCount;

    /// @dev Per-outcome display names.
    string[] private _outcomeNames;
    /// @dev Virtual AMM reserves per outcome (collateral base units).
    uint256[] private _reserves;

    /// @notice Collateral backing outstanding complete sets (== contract native balance).
    uint256 public totalSets;

    /// @dev Winning outcome; meaningful only once status == Resolved.
    uint256 private _winningOutcome;

    /// @dev Reentrancy lock: 1 = not entered, 2 = entered (storage-based; the Paris target has
    ///      no transient storage). Set to 1 in {initialize}.
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

    /// @inheritdoc IPredictionMarket
    function initialize(address controller_, address treasury_, MarketParams calldata params)
        external
        payable
        initializer
    {
        if (controller_ == address(0) || treasury_ == address(0) || params.creator == address(0)) {
            revert ZeroAddress();
        }
        uint256 n = params.outcomeNames.length;
        if (n < 2 || n > MAX_OUTCOMES) revert InvalidOutcomeCount();
        if (params.feeBps > MAX_FEE_BPS || params.protocolFeeShareBps > FeeMath.BPS) revert InvalidFee();
        if (!(block.timestamp < params.lockTime && params.lockTime <= params.resolveTime)) {
            revert InvalidTiming();
        }
        if (msg.value == 0) revert ZeroAmount();

        __ERC1155_init("");
        __ERC1155Supply_init();
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

        uint256 seed = msg.value;
        for (uint256 i = 0; i < n; ++i) {
            _outcomeNames.push(params.outcomeNames[i]);
            _reserves.push(seed);
        }
        totalSets = seed;
        _mint(params.creator, LP_TOKEN_ID, seed, "");
        emit LiquidityAdded(address(this), params.creator, seed, seed);
    }

    // ----------------------------------------------------------------------------------------
    // Lifecycle (controller only)
    // ----------------------------------------------------------------------------------------

    /// @inheritdoc IPredictionMarket
    function pause() external onlyController {
        if (status != MarketStatus.Open) revert MarketNotOpen();
        status = MarketStatus.Paused;
        emit MarketPaused(address(this));
    }

    /// @inheritdoc IPredictionMarket
    function unpause() external onlyController {
        if (status != MarketStatus.Paused) revert MarketNotOpen();
        status = MarketStatus.Open;
        emit MarketUnpaused(address(this));
    }

    /// @inheritdoc IPredictionMarket
    function close() external onlyController {
        _requireNotEnded();
        status = MarketStatus.Closed;
        emit MarketClosed(address(this));
    }

    /// @inheritdoc IPredictionMarket
    function resolve(uint256 winningOutcome_) external onlyController {
        _requireNotEnded();
        if (winningOutcome_ >= outcomeCount) revert InvalidOutcome();
        _winningOutcome = winningOutcome_;
        status = MarketStatus.Resolved;
        emit MarketResolved(address(this), winningOutcome_);
    }

    /// @inheritdoc IPredictionMarket
    function voidMarket() external onlyController {
        _requireNotEnded();
        status = MarketStatus.Voided;
        emit MarketVoided(address(this));
    }

    /// @inheritdoc IPredictionMarket
    function setTreasury(address treasury_) external onlyController {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
    }

    // ----------------------------------------------------------------------------------------
    // Trading
    // ----------------------------------------------------------------------------------------

    /// @inheritdoc IPredictionMarket
    function buy(uint256 outcomeIndex, uint256 minSharesOut, uint256 deadline)
        external
        payable
        nonReentrant
        returns (uint256 sharesOut)
    {
        if (block.timestamp > deadline) revert DeadlineExpired();
        _requireTradable(outcomeIndex);
        uint256 amountIn = msg.value;
        if (amountIn == 0) revert ZeroAmount();

        uint256 fee = FeeMath.feeOnAmount(amountIn, feeBps);
        uint256 cut = FeeMath.protocolCut(fee, protocolFeeShareBps);
        uint256 lpFee = fee - cut;
        uint256 invest = amountIn - fee;

        sharesOut = MarketMath.calcBuyShares(_reserves, outcomeIndex, invest);
        if (sharesOut < minSharesOut) revert SlippageExceeded();

        // Effects: add (invest + lpFee) to every reserve, then hand the buyer their shares out
        // of the bought outcome. Both amounts of collateral stay in the contract.
        uint256 addAll = invest + lpFee;
        uint256 n = outcomeCount;
        for (uint256 j = 0; j < n; ++j) {
            _reserves[j] += addAll;
        }
        _reserves[outcomeIndex] -= sharesOut;
        totalSets += addAll;
        _mint(msg.sender, outcomeIndex, sharesOut, "");

        // Interaction: forward the protocol cut.
        if (cut > 0) {
            IPredictionTreasury(treasury).depositFee{ value: cut }(address(this));
        }
        emit PredictionPlaced(address(this), msg.sender, outcomeIndex, amountIn, sharesOut);
    }

    /// @inheritdoc IPredictionMarket
    function sell(uint256 outcomeIndex, uint256 returnAmount, uint256 maxSharesIn, uint256 deadline)
        external
        nonReentrant
        returns (uint256 sharesIn)
    {
        if (block.timestamp > deadline) revert DeadlineExpired();
        _requireTradable(outcomeIndex);
        if (returnAmount == 0) revert ZeroAmount();

        uint256 gross = FeeMath.grossFromNet(returnAmount, feeBps);
        uint256 fee = gross - returnAmount;
        uint256 cut = FeeMath.protocolCut(fee, protocolFeeShareBps);
        uint256 lpFee = fee - cut;

        sharesIn = MarketMath.calcSellShares(_reserves, outcomeIndex, gross);
        if (sharesIn > maxSharesIn) revert SlippageExceeded();

        // Effects: burn the seller's shares, merge `gross` complete sets out of the pool, then
        // re-inject the LP fee as fresh liquidity.
        _burn(msg.sender, outcomeIndex, sharesIn);
        uint256 n = outcomeCount;
        for (uint256 j = 0; j < n; ++j) {
            if (j != outcomeIndex) {
                _reserves[j] -= gross;
            }
        }
        _reserves[outcomeIndex] = _reserves[outcomeIndex] + sharesIn - gross;
        totalSets -= gross;
        if (lpFee > 0) {
            for (uint256 j = 0; j < n; ++j) {
                _reserves[j] += lpFee;
            }
            totalSets += lpFee;
        }

        // Interactions: protocol cut out, then pay the seller.
        if (cut > 0) {
            IPredictionTreasury(treasury).depositFee{ value: cut }(address(this));
        }
        _sendNative(msg.sender, returnAmount);
        emit PredictionSold(address(this), msg.sender, outcomeIndex, sharesIn, returnAmount);
    }

    // ----------------------------------------------------------------------------------------
    // Liquidity
    // ----------------------------------------------------------------------------------------

    /// @inheritdoc IPredictionMarket
    function addFunding(uint256 minLpSharesOut) external payable nonReentrant returns (uint256 lpShares) {
        if (status != MarketStatus.Open) revert MarketNotOpen();
        if (block.timestamp >= lockTime) revert TradingLocked();
        uint256 amount = msg.value;
        if (amount == 0) revert ZeroAmount();

        uint256 n = outcomeCount;
        uint256 lpSupply = totalSupply(LP_TOKEN_ID);

        if (lpSupply == 0) {
            for (uint256 j = 0; j < n; ++j) {
                _reserves[j] += amount;
            }
            lpShares = amount;
        } else {
            uint256 maxR = MarketMath.maxReserve(_reserves);
            lpShares = Math.mulDiv(amount, lpSupply, maxR);
            for (uint256 j = 0; j < n; ++j) {
                uint256 keep = Math.mulDiv(amount, _reserves[j], maxR);
                uint256 sendBack = amount - keep;
                _reserves[j] += keep;
                if (sendBack > 0) {
                    _mint(msg.sender, j, sendBack, "");
                }
            }
        }
        totalSets += amount;
        if (lpShares < minLpSharesOut) revert SlippageExceeded();
        _mint(msg.sender, LP_TOKEN_ID, lpShares, "");
        emit LiquidityAdded(address(this), msg.sender, amount, lpShares);
    }

    /// @inheritdoc IPredictionMarket
    function removeFunding(uint256 lpShares) external nonReentrant {
        if (lpShares == 0) revert ZeroAmount();
        uint256 lpSupply = totalSupply(LP_TOKEN_ID);
        _burn(msg.sender, LP_TOKEN_ID, lpShares);

        uint256 n = outcomeCount;
        for (uint256 j = 0; j < n; ++j) {
            uint256 out = Math.mulDiv(_reserves[j], lpShares, lpSupply);
            if (out > 0) {
                _reserves[j] -= out;
                _mint(msg.sender, j, out, "");
            }
        }
        emit LiquidityRemoved(address(this), msg.sender, lpShares);
    }

    /// @inheritdoc IPredictionMarket
    function mergeSets(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (status == MarketStatus.Resolved || status == MarketStatus.Voided) revert MarketAlreadyEnded();
        uint256 n = outcomeCount;
        for (uint256 j = 0; j < n; ++j) {
            _burn(msg.sender, j, amount);
        }
        totalSets -= amount;
        _sendNative(msg.sender, amount);
        emit RewardClaimed(address(this), msg.sender, amount);
    }

    // ----------------------------------------------------------------------------------------
    // Redemption
    // ----------------------------------------------------------------------------------------

    /// @inheritdoc IPredictionMarket
    function redeem() external nonReentrant returns (uint256 payout) {
        MarketStatus s = status;
        uint256 n = outcomeCount;

        if (s == MarketStatus.Resolved) {
            uint256 win = _winningOutcome;
            uint256 held = balanceOf(msg.sender, win);
            if (held == 0) revert NothingToClaim();
            _burn(msg.sender, win, held);
            payout = held;
        } else if (s == MarketStatus.Voided) {
            uint256 sum;
            for (uint256 j = 0; j < n; ++j) {
                uint256 b = balanceOf(msg.sender, j);
                if (b > 0) {
                    sum += b;
                    _burn(msg.sender, j, b);
                }
            }
            if (sum == 0) revert NothingToClaim();
            payout = sum / n;
        } else {
            revert MarketNotResolved();
        }

        if (payout > totalSets) {
            payout = totalSets;
        }
        totalSets -= payout;
        _sendNative(msg.sender, payout);
        emit RewardClaimed(address(this), msg.sender, payout);
    }

    // ----------------------------------------------------------------------------------------
    // Views
    // ----------------------------------------------------------------------------------------

    /// @inheritdoc IPredictionMarket
    function winningOutcome() external view returns (uint256) {
        if (status != MarketStatus.Resolved) revert MarketNotResolved();
        return _winningOutcome;
    }

    /// @inheritdoc IPredictionMarket
    function getReserves() external view returns (uint256[] memory) {
        return _reserves;
    }

    /// @inheritdoc IPredictionMarket
    function getPrices() external view returns (uint256[] memory) {
        return MarketMath.prices(_reserves);
    }

    /// @inheritdoc IPredictionMarket
    function calcBuy(uint256 outcomeIndex, uint256 amountIn) external view returns (uint256 sharesOut) {
        if (outcomeIndex >= outcomeCount) revert InvalidOutcome();
        uint256 invest = amountIn - FeeMath.feeOnAmount(amountIn, feeBps);
        sharesOut = MarketMath.calcBuyShares(_reserves, outcomeIndex, invest);
    }

    /// @inheritdoc IPredictionMarket
    function calcSell(uint256 outcomeIndex, uint256 returnAmount) external view returns (uint256 sharesIn) {
        if (outcomeIndex >= outcomeCount) revert InvalidOutcome();
        sharesIn = MarketMath.calcSellShares(_reserves, outcomeIndex, FeeMath.grossFromNet(returnAmount, feeBps));
    }

    /**
     * @notice The display name of an outcome.
     * @param outcomeIndex Outcome index.
     * @return The outcome's name.
     */
    function outcomeName(uint256 outcomeIndex) external view returns (string memory) {
        if (outcomeIndex >= outcomeCount) revert InvalidOutcome();
        return _outcomeNames[outcomeIndex];
    }

    // ----------------------------------------------------------------------------------------
    // Internal
    // ----------------------------------------------------------------------------------------

    /// @dev Reverts unless the market is Open, unlocked, and the outcome exists.
    function _requireTradable(uint256 outcomeIndex) private view {
        if (status != MarketStatus.Open) revert MarketNotOpen();
        if (block.timestamp >= lockTime) revert TradingLocked();
        if (outcomeIndex >= outcomeCount) revert InvalidOutcome();
    }

    /// @dev Reverts if the market has already reached a terminal status.
    function _requireNotEnded() private view {
        if (status == MarketStatus.Resolved || status == MarketStatus.Voided) revert MarketAlreadyEnded();
    }

    /// @dev Native transfer with an explicit success check.
    function _sendNative(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok, ) = payable(to).call{ value: amount }("");
        if (!ok) revert TransferFailed();
    }
}
