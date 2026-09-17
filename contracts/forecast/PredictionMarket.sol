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
    ClaimWindowOpen,
    ClaimWindowClosed,
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
    MarketVoided,
    UnclaimedSwept,
    PayoutDeferred,
    DistributionAdvanced,
    AutoDistributeSet
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
 *      native balance (the whole trade fee leaves for the treasury). Winning shares therefore
 *      always redeem 1:1 without the pool going insolvent.
 *
 *      The invariant holds for the whole life of the market, right through the one-year claim
 *      window that starts at settlement. {sweepUnclaimed} retires it: once the window has
 *      closed nothing can be redeemed any more, so the leftover collateral and `totalSets`
 *      both go to zero together and outstanding share balances become inert bookkeeping.
 *
 *      Settlement pays holders out by itself. It also splits the pot exactly: at that moment
 *      `reserves[win] + totalSupply(win) == totalSets`, so paying every winning share 1:1 and
 *      handing `reserves[win]` to the LPs pro-rata distributes the collateral to the last wei.
 *      With {autoDistribute} switched on, {resolve} and {voidMarket} push the first
 *      {AUTO_DISTRIBUTE_BATCH} accounts in the same transaction and anyone can carry the rest
 *      with {distribute}. That push is off until an admin asks for it ({setAutoDistribute}),
 *      and it is never the only way out either way, because {distribute} is permissionless
 *      and {redeem} always lets a holder collect their own share.
 */
contract PredictionMarket is IPredictionMarket, Initializable, ERC1155SupplyUpgradeable {
    /// @notice ERC-1155 id used for liquidity-provider shares (outcomes use ids 0..n-1).
    uint256 public constant LP_TOKEN_ID = type(uint256).max;

    /// @notice Maximum supported outcomes (bounds every per-outcome loop).
    uint256 public constant MAX_OUTCOMES = 16;

    /// @notice Maximum total trade fee (10%).
    uint16 public constant MAX_FEE_BPS = 1000;

    /// @notice How long winners keep the right to redeem after the market settles. Once it
    ///         elapses the leftover collateral is sweepable to the treasury.
    uint64 public constant CLAIM_WINDOW = 365 days;

    /// @notice Payouts pushed inside the settlement transaction itself. Small markets are
    ///         therefore paid out in full the moment an admin resolves or voids them;
    ///         anything larger is carried by {distribute} calls afterwards.
    uint256 public constant AUTO_DISTRIBUTE_BATCH = 20;

    /// @dev Gas forwarded to each pushed payout. Enough for an ordinary wallet or a plain
    ///      `receive()`, and low enough that one hostile recipient cannot burn the batch.
    ///      Whatever it cannot deliver becomes a pullable credit, so nobody loses money.
    uint256 private constant PUSH_GAS = 50_000;

    /// @notice The factory; the only address allowed to drive lifecycle actions.
    address public controller;

    /// @notice Treasury that receives protocol fees.
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

    /// @notice Account credited as the market's creator/first LP.
    address public creator;

    /// @notice Creation timestamp.
    uint64 public createdAt;
    /// @notice Trading closes at this timestamp.
    uint64 public lockTime;
    /// @notice Intended resolution timestamp (informational; admin resolves).
    uint64 public resolveTime;

    /// @notice Total trade fee in basis points; the whole of it goes to the treasury.
    uint16 public feeBps;
    /// @notice Category this market is filed under, in the factory's registry. The name a
    ///         reader sees is looked up there, per language.
    uint32 public categoryId;
    /// @notice When the market settled (Resolved or Voided); 0 while it is still live. The
    ///         claim window runs for {CLAIM_WINDOW} from this instant.
    uint64 public endedAt;

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

    /// @dev Every account that has ever received a token of this market, in first-receipt
    ///      order; the distribution walks it. Append-only: a zero balance is skipped at
    ///      payout time, which is cheaper than keeping the list pruned on every transfer.
    address[] private _holders;
    /// @dev Membership test that keeps `_holders` free of duplicates.
    mapping(address account => bool listed) private _listed;
    /// @dev How far the push has walked `_holders`.
    uint256 private _cursor;
    /// @dev Payouts a push could not deliver, waiting to be pulled by {redeem}.
    mapping(address account => uint256 amount) private _credited;
    /// @dev LP supply at settlement, and the collateral that belongs to LPs as a whole
    ///      (`reserves[win]` when resolved, the mean reserve when voided). Snapshotted
    ///      because burning LP shares during the payout walk moves the live supply.
    uint256 private _lpSupplyAtEnd;
    uint256 private _lpPoolAtEnd;

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
        if (params.feeBps > MAX_FEE_BPS) revert InvalidFee();
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
        categoryId = params.categoryId;
        imageURI = params.imageURI;
        creator = params.creator;
        createdAt = uint64(block.timestamp);
        lockTime = params.lockTime;
        resolveTime = params.resolveTime;
        feeBps = params.feeBps;
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
    function resolve(uint256 winningOutcome_) external onlyController nonReentrant {
        _requireNotEnded();
        if (winningOutcome_ >= outcomeCount) revert InvalidOutcome();
        _winningOutcome = winningOutcome_;
        status = MarketStatus.Resolved;
        endedAt = uint64(block.timestamp);

        // What the losing reserves were worth is now the LPs' share of the pot.
        _snapshotLp(_reserves[winningOutcome_]);
        emit MarketResolved(address(this), winningOutcome_);

        // Winners do not have to come and ask: start paying them right here, unless an admin
        // has turned that off for this market.
        if (autoDistribute) {
            _pushPayouts(AUTO_DISTRIBUTE_BATCH);
        }
    }

    /// @inheritdoc IPredictionMarket
    function voidMarket() external onlyController nonReentrant {
        _requireNotEnded();
        status = MarketStatus.Voided;
        endedAt = uint64(block.timestamp);

        // Refunds treat holdings as fractional complete sets, so an LP's reserves are worth
        // the mean reserve on the same basis.
        uint256 n = outcomeCount;
        uint256 sum;
        for (uint256 j = 0; j < n; ++j) {
            sum += _reserves[j];
        }
        _snapshotLp(sum / n);
        emit MarketVoided(address(this));

        // Refunds go back out on their own, exactly like winnings do.
        if (autoDistribute) {
            _pushPayouts(AUTO_DISTRIBUTE_BATCH);
        }
    }

    /// @inheritdoc IPredictionMarket
    function setTreasury(address treasury_) external onlyController {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
    }

    /// @inheritdoc IPredictionMarket
    function setAutoDistribute(bool enabled) external onlyController {
        autoDistribute = enabled;
        emit AutoDistributeSet(address(this), enabled);
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
        uint256 invest = amountIn - fee;

        sharesOut = MarketMath.calcBuyShares(_reserves, outcomeIndex, invest);
        if (sharesOut < minSharesOut) revert SlippageExceeded();

        // Effects: add `invest` to every reserve, then hand the buyer their shares out of the
        // bought outcome. That collateral stays in the contract; the fee does not.
        uint256 n = outcomeCount;
        for (uint256 j = 0; j < n; ++j) {
            _reserves[j] += invest;
        }
        _reserves[outcomeIndex] -= sharesOut;
        totalSets += invest;
        _mint(msg.sender, outcomeIndex, sharesOut, "");

        // Interaction: forward the whole fee.
        if (fee > 0) {
            IPredictionTreasury(treasury).depositFee{ value: fee }(address(this));
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

        sharesIn = MarketMath.calcSellShares(_reserves, outcomeIndex, gross);
        if (sharesIn > maxSharesIn) revert SlippageExceeded();

        // Effects: burn the seller's shares and merge `gross` complete sets out of the pool.
        _burn(msg.sender, outcomeIndex, sharesIn);
        uint256 n = outcomeCount;
        for (uint256 j = 0; j < n; ++j) {
            if (j != outcomeIndex) {
                _reserves[j] -= gross;
            }
        }
        _reserves[outcomeIndex] = _reserves[outcomeIndex] + sharesIn - gross;
        totalSets -= gross;

        // Interactions: fee out, then pay the seller.
        if (fee > 0) {
            IPredictionTreasury(treasury).depositFee{ value: fee }(address(this));
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
        // Once the market has settled, LP shares are paid in collateral by the distribution
        // instead; converting them to outcome tokens here would pay the same reserves twice.
        _requireNotEnded();
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
        _requireClaimWindowOpen();

        uint256 credit = _credited[msg.sender];
        if (credit > 0) {
            // A push already set this money aside; it just could not be delivered.
            _credited[msg.sender] = 0;
            payout = credit;
        } else {
            MarketStatus s = status;
            if (s != MarketStatus.Resolved && s != MarketStatus.Voided) revert MarketNotResolved();
            payout = _settleAccount(msg.sender);
            if (payout == 0) revert NothingToClaim();
        }

        _sendNative(msg.sender, payout);
        emit RewardClaimed(address(this), msg.sender, payout);
    }

    // ----------------------------------------------------------------------------------------
    // Automatic distribution
    // ----------------------------------------------------------------------------------------

    /// @inheritdoc IPredictionMarket
    function distribute(uint256 limit) external nonReentrant returns (uint256 paid) {
        if (endedAt == 0) revert MarketNotResolved();
        if (limit == 0) revert ZeroAmount();
        _requireClaimWindowOpen();
        paid = _pushPayouts(limit);
    }

    // ----------------------------------------------------------------------------------------
    // Residue sweep
    // ----------------------------------------------------------------------------------------

    /// @inheritdoc IPredictionMarket
    function sweepUnclaimed() external onlyController nonReentrant returns (uint256 amount) {
        uint64 deadline = claimDeadline();
        if (deadline == 0) revert MarketNotResolved();
        if (block.timestamp < deadline) revert ClaimWindowOpen();

        // The whole balance, not just `totalSets`: anything force-fed to the market is dust
        // nobody can redeem, and after the window there is no accounting left to protect.
        amount = address(this).balance;
        if (amount == 0) revert ZeroAmount();

        // Effects: the market is now empty and {redeem} is already closed by the deadline.
        totalSets = 0;

        address to = treasury;
        IPredictionTreasury(to).depositFee{ value: amount }(address(this));
        emit UnclaimedSwept(address(this), to, amount);
    }

    // ----------------------------------------------------------------------------------------
    // Views
    // ----------------------------------------------------------------------------------------

    /// @inheritdoc IPredictionMarket
    function claimDeadline() public view returns (uint64) {
        uint64 ended = endedAt;
        return ended == 0 ? 0 : ended + CLAIM_WINDOW;
    }

    /// @inheritdoc IPredictionMarket
    function distributionProgress() external view returns (uint256 cursor, uint256 total) {
        return (_cursor, _holders.length);
    }

    /// @inheritdoc IPredictionMarket
    function pendingPayout(address account) external view returns (uint256) {
        uint256 credit = _credited[account];
        if (credit > 0) {
            return credit;
        }
        if (endedAt == 0) {
            return 0;
        }
        return _payoutOf(account);
    }

    /// @notice Total accounts that have ever held a token of this market (the distribution's
    ///         length). Includes accounts whose balance has since gone to zero.
    function holderCount() external view returns (uint256) {
        return _holders.length;
    }

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

    /// @dev Reverts once the claim window has elapsed. The cut-off is the deadline itself,
    ///      not the sweep transaction, so redemption stops at the same instant for everyone
    ///      whether or not an admin has already collected the residue.
    function _requireClaimWindowOpen() private view {
        uint64 deadline = claimDeadline();
        if (deadline != 0 && block.timestamp >= deadline) revert ClaimWindowClosed();
    }

    /// @dev Records the LP side of the pot at settlement: how many LP shares exist and how
    ///      much collateral they collectively own.
    function _snapshotLp(uint256 lpPool) private {
        _lpSupplyAtEnd = totalSupply(LP_TOKEN_ID);
        _lpPoolAtEnd = lpPool;
    }

    /// @dev What `account` is owed at the current settlement, without paying it: their winning
    ///      shares (or refund basis) plus their pro-rata slice of the LP pot.
    function _payoutOf(address account) private view returns (uint256 payout) {
        uint256 n = outcomeCount;
        if (status == MarketStatus.Resolved) {
            payout = balanceOf(account, _winningOutcome);
        } else if (status == MarketStatus.Voided) {
            uint256 sum;
            for (uint256 j = 0; j < n; ++j) {
                sum += balanceOf(account, j);
            }
            payout = sum / n;
        } else {
            return 0;
        }

        uint256 lp = balanceOf(account, LP_TOKEN_ID);
        if (lp > 0 && _lpSupplyAtEnd > 0) {
            payout += Math.mulDiv(lp, _lpPoolAtEnd, _lpSupplyAtEnd);
        }
        if (payout > totalSets) {
            payout = totalSets;
        }
    }

    /// @dev Burns everything `account` holds and books their payout against `totalSets`. The
    ///      burn is what makes settlement one-shot: a second pass finds a zero balance.
    function _settleAccount(address account) private returns (uint256 payout) {
        payout = _payoutOf(account);

        uint256 n = outcomeCount;
        if (status == MarketStatus.Resolved) {
            uint256 win = _winningOutcome;
            uint256 held = balanceOf(account, win);
            if (held > 0) {
                _burn(account, win, held);
            }
        } else {
            for (uint256 j = 0; j < n; ++j) {
                uint256 b = balanceOf(account, j);
                if (b > 0) {
                    _burn(account, j, b);
                }
            }
        }
        uint256 lp = balanceOf(account, LP_TOKEN_ID);
        if (lp > 0) {
            _burn(account, LP_TOKEN_ID, lp);
        }

        totalSets -= payout;
    }

    /// @dev Pays up to `limit` further holders and advances the cursor. Each account's tokens
    ///      are burned before its transfer, and a transfer that fails becomes a credit rather
    ///      than a revert, so one recipient can never stall the queue behind it.
    function _pushPayouts(uint256 limit) private returns (uint256 paid) {
        uint256 i = _cursor;
        uint256 total = _holders.length;
        uint256 end = i + limit;
        if (end > total) {
            end = total;
        }

        for (; i < end; ++i) {
            address account = _holders[i];
            uint256 payout = _settleAccount(account);
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

    /// @dev Lists every account that receives a token so settlement knows who to pay. The
    ///      market is the sole issuer and never custodies its own tokens, so this list is
    ///      always a superset of the current holders.
    function _update(address from, address to, uint256[] memory ids, uint256[] memory values)
        internal
        override
    {
        super._update(from, to, ids, values);
        if (to != address(0) && !_listed[to]) {
            _listed[to] = true;
            _holders.push(to);
        }
    }

    /// @dev Native transfer with an explicit success check.
    function _sendNative(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok, ) = payable(to).call{ value: amount }("");
        if (!ok) revert TransferFailed();
    }
}
