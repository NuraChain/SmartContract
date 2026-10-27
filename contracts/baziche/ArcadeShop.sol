// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControlDefaultAdminRules} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title ArcadeShop
 * @notice Sells Arcade's looks - dice, pawns, card backs, avatar decorations and the rest - for
 *         native NURA. A buyer pays this contract from their own wallet, and the sale is what the
 *         Arcade server reads before it hands the look over.
 *
 * The server prices every sale: it signs a `Quote` (EIP-712) for one order, one buyer and one
 * price, good for a short while, with the key that holds SELLER_ROLE. The buyer sends the quote
 * and its exact price to `buy`, and the contract takes it only as it was signed:
 *
 *   - from the buyer it names, at exactly its price, before its deadline;
 *   - once per order, whatever became of the sale;
 *   - signed by a key that holds SELLER_ROLE at the moment of the sale.
 *
 * So a wrong payment never leaves a wallet: another buyer, another price, an expired quote or
 * an order already sold is refused, and the coin stays where it was. What the seller's key can
 * do is sign quotes, and nothing else; a leaked key can give looks away, never move coin, and
 * `setSeller` or `revokeRole` ends it.
 *
 * Whoever brought a buyer in, named by the server in the quote, is credited `referralBps` of the
 * price, and claims it whenever they like. The rest is the owner's revenue, which only the owner
 * withdraws. The owner can refund a sale: the whole price goes back to its buyer, the inviter's
 * credit is taken back while it is unclaimed, and the rest comes out of revenue.
 *
 * @dev Deliberate omissions:
 *
 *      - No upgradeability. A new version is a new address; what a sale recorded stays where it
 *        is.
 *      - No price list on chain. Prices, sales and bundles are the server's, signed per order,
 *        so changing a price is not a transaction the owner has to send.
 *      - No path from the owner to an inviter's credit, except through the refund of the sale
 *        that earned it.
 *      - No `receive`. Coin comes in through `buy`, and through `fund` when the owner tops up
 *        revenue for a refund; a plain transfer is refused rather than left nobody's.
 *      - One owner, handed over in two steps, as the vault is: `beginDefaultAdminTransfer`, then
 *        `acceptDefaultAdminTransfer` from the next owner; PAUSER_ROLE goes with it.
 *      - Coin leaves only in `refund`, `withdraw` and `claim`, each after its state is written
 *        and behind nonReentrant. `buy` hands control to nobody.
 */
contract ArcadeShop is AccessControlDefaultAdminRules, Pausable, ReentrancyGuard, EIP712 {
    /// @notice May sign quotes. Meant for the Arcade server's key alone.
    bytes32 public constant SELLER_ROLE = keccak256("SELLER_ROLE");

    /// @notice May pause and unpause new sales.
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @notice The most of a sale an inviter can ever be given: 30%.
    uint16 public constant MAX_REFERRAL_BPS = 3_000;

    /// @notice The longest a quote may still have to run when it is used. Arcade's quotes are
    ///         good for thirty minutes; a quote good for a year would be a price held for a year.
    uint256 public constant MAX_QUOTE_LIFE = 1 days;

    uint256 private constant BPS = 10_000;

    bytes32 private constant QUOTE_TYPEHASH = keccak256(
        "Quote(bytes32 order,address buyer,bytes32 item,uint256 price,address referrer,uint64 deadline)"
    );

    /**
     * @notice One order, as the seller priced it.
     * @param order    The order's id, used once ever.
     * @param buyer    The only address that may pay it.
     * @param item     What is being bought, as the server names it; recorded in `Bought`.
     * @param price    Exactly what `buy` must be sent, in wei.
     * @param referrer Whoever brought the buyer in, or the zero address.
     * @param deadline Unix time after which the quote is no longer good.
     */
    struct Quote {
        bytes32 order;
        address buyer;
        bytes32 item;
        uint256 price;
        address referrer;
        uint64 deadline;
    }

    struct Sale {
        address buyer;
        uint64 paidAt;
        bool refunded;
        address referrer;
        uint256 price;
        uint256 cut;
    }

    /// @notice The key quotes are signed with, as last set by the constructor or `setSeller`.
    address public seller;

    /// @notice The part of a sale its inviter is credited, in basis points, for sales from now on.
    uint16 public referralBps;

    /// @notice The owner's: every sale's price less its inviter's cut, less refunds and withdrawals.
    uint256 public revenue;

    /// @notice The sum of every inviter's unclaimed credit.
    uint256 public totalEarnings;

    /// @notice What each inviter can claim now.
    mapping(address referrer => uint256 amount) public earnings;

    mapping(bytes32 order => Sale) private _sales;

    event Bought(
        bytes32 indexed order,
        address indexed buyer,
        bytes32 indexed item,
        uint256 price,
        address referrer,
        uint256 cut
    );
    event Refunded(bytes32 indexed order, address indexed buyer, uint256 price, uint256 fromEarnings);
    event Claimed(address indexed referrer, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event Funded(address indexed from, uint256 amount);
    event SellerChanged(address indexed previousSeller, address indexed newSeller);
    event ReferralBpsChanged(uint16 previousBps, uint16 newBps);

    error ZeroAddress();
    error ZeroAmount();
    error ReferralBpsOutOfRange(uint16 bps);
    error OrderSold(bytes32 order);
    error NotBuyer(bytes32 order, address buyer);
    error WrongPrice(bytes32 order, uint256 price, uint256 sent);
    error QuoteExpired(bytes32 order, uint64 deadline);
    error QuoteTooLong(bytes32 order, uint64 deadline);
    error InvalidSignature(bytes32 order);
    error NotSold(bytes32 order);
    error AlreadyRefunded(bytes32 order);
    error InsufficientRevenue(uint256 available, uint256 required);
    error NothingToClaim();

    /**
     * @param admin        The owner: receives DEFAULT_ADMIN_ROLE and PAUSER_ROLE. The owner's wallet, or a multisig.
     * @param seller_      The Arcade server's key. Receives SELLER_ROLE.
     * @param referralBps_ The part of a sale its inviter is credited, from 0 to MAX_REFERRAL_BPS. 1000 is 10%.
     */
    constructor(address admin, address seller_, uint16 referralBps_)
        AccessControlDefaultAdminRules(0, admin)
        EIP712("ArcadeShop", "1")
    {
        if (seller_ == address(0)) revert ZeroAddress();
        _checkReferralBps(referralBps_);

        seller = seller_;
        referralBps = referralBps_;

        _grantRole(PAUSER_ROLE, admin);
        _grantRole(SELLER_ROLE, seller_);

        emit SellerChanged(address(0), seller_);
        emit ReferralBpsChanged(0, referralBps_);
    }

    // -------------------------------------------------------------------------------
    // Buying
    // -------------------------------------------------------------------------------

    /**
     * @notice Pays for one order, exactly as the seller priced it.
     * @param quote     The order, its buyer, its price, its inviter and its deadline.
     * @param signature The seller's signature over `quote`.
     * @dev Refuses by name - OrderSold, NotBuyer, ZeroAmount, WrongPrice, QuoteExpired,
     *      QuoteTooLong, InvalidSignature - so a wallet that simulates the call first says why.
     *      A referrer that is the buyer themselves is no referrer. Sends nothing.
     */
    function buy(Quote calldata quote, bytes calldata signature) external payable whenNotPaused {
        bytes32 order = quote.order;
        Sale storage sale = _sales[order];
        if (sale.buyer != address(0)) revert OrderSold(order);

        address buyer = _msgSender();
        if (quote.buyer != buyer) revert NotBuyer(order, quote.buyer);
        if (quote.price == 0) revert ZeroAmount();
        if (msg.value != quote.price) revert WrongPrice(order, quote.price, msg.value);
        if (quote.deadline < block.timestamp) revert QuoteExpired(order, quote.deadline);
        if (quote.deadline > block.timestamp + MAX_QUOTE_LIFE) revert QuoteTooLong(order, quote.deadline);

        (address signer, ECDSA.RecoverError failure,) = ECDSA.tryRecoverCalldata(_digest(quote), signature);
        if (failure != ECDSA.RecoverError.NoError || !hasRole(SELLER_ROLE, signer)) revert InvalidSignature(order);

        address referrer = quote.referrer == buyer ? address(0) : quote.referrer;
        uint256 cut = referrer == address(0) ? 0 : (quote.price * referralBps) / BPS;

        sale.buyer = buyer;
        sale.paidAt = uint64(block.timestamp);
        sale.referrer = referrer;
        sale.price = quote.price;
        sale.cut = cut;

        if (cut != 0) {
            earnings[referrer] += cut;
            totalEarnings += cut;
        }
        revenue += quote.price - cut;

        emit Bought(order, buyer, quote.item, quote.price, referrer, cut);
    }

    /**
     * @notice Sends the caller every NURA they have been credited for bringing buyers in.
     * @dev Never paused. The credit is cleared before the transfer, and nonReentrant is the
     *      second line of defence against a receiver that calls back in.
     */
    function claim() external nonReentrant {
        address referrer = _msgSender();
        uint256 amount = earnings[referrer];
        if (amount == 0) revert NothingToClaim();

        earnings[referrer] = 0;
        totalEarnings -= amount;

        emit Claimed(referrer, amount);
        Address.sendValue(payable(referrer), amount);
    }

    // -------------------------------------------------------------------------------
    // The owner
    // -------------------------------------------------------------------------------

    /**
     * @notice Gives one sale's whole price back to its buyer and marks it refunded.
     * @dev The inviter's cut is taken back from their unclaimed credit as far as it reaches;
     *      whatever they already claimed comes out of revenue, so the buyer is always paid in
     *      full. An order refunded stays sold: it can never be bought again.
     */
    function refund(bytes32 order) external nonReentrant onlyRole(DEFAULT_ADMIN_ROLE) {
        Sale storage sale = _sales[order];
        address buyer = sale.buyer;
        if (buyer == address(0)) revert NotSold(order);
        if (sale.refunded) revert AlreadyRefunded(order);

        uint256 price = sale.price;
        uint256 back;
        if (sale.cut != 0) {
            uint256 unclaimed = earnings[sale.referrer];
            back = sale.cut < unclaimed ? sale.cut : unclaimed;
        }
        uint256 owed = price - back;
        if (owed > revenue) revert InsufficientRevenue(revenue, owed);

        sale.refunded = true;
        if (back != 0) {
            earnings[sale.referrer] -= back;
            totalEarnings -= back;
        }
        revenue -= owed;

        emit Refunded(order, buyer, price, back);
        Address.sendValue(payable(buyer), price);
    }

    /// @notice Sends revenue to `to`. What inviters have not claimed is never revenue.
    function withdraw(address to, uint256 amount) external nonReentrant onlyRole(DEFAULT_ADMIN_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (amount > revenue) revert InsufficientRevenue(revenue, amount);

        revenue -= amount;

        emit Withdrawn(to, amount);
        Address.sendValue(payable(to), amount);
    }

    /// @notice Adds the coin sent to revenue, so a refund can be paid after revenue was withdrawn.
    function fund() external payable onlyRole(DEFAULT_ADMIN_ROLE) {
        if (msg.value == 0) revert ZeroAmount();

        revenue += msg.value;
        emit Funded(_msgSender(), msg.value);
    }

    /**
     * @notice Moves SELLER_ROLE from the current `seller` to `newSeller` in one call.
     * @dev Quotes the old key signed stop being good at once. Any other seller granted with
     *      `grantRole` keeps its role; `revokeRole` takes it.
     */
    function setSeller(address newSeller) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newSeller == address(0)) revert ZeroAddress();

        address previous = seller;
        seller = newSeller;
        _revokeRole(SELLER_ROLE, previous);
        _grantRole(SELLER_ROLE, newSeller);

        emit SellerChanged(previous, newSeller);
    }

    /// @notice Sets the part of a sale its inviter is credited, for sales from now on.
    function setReferralBps(uint16 newBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _checkReferralBps(newBps);

        emit ReferralBpsChanged(referralBps, newBps);
        referralBps = newBps;
    }

    /// @notice Stops new sales. Claims, refunds and withdrawals carry on.
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Lets sales start again.
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // -------------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------------

    /// @notice One order's sale: who paid, when, whether it was refunded, its inviter, its price
    ///         and the inviter's cut. A buyer of the zero address means it was never sold.
    function saleOf(bytes32 order)
        external
        view
        returns (address buyer, uint64 paidAt, bool refunded, address referrer, uint256 price, uint256 cut)
    {
        Sale storage sale = _sales[order];
        return (sale.buyer, sale.paidAt, sale.refunded, sale.referrer, sale.price, sale.cut);
    }

    /// @notice The EIP-712 digest the seller signs for one quote. For servers and tests.
    function quoteDigest(Quote calldata quote) external view returns (bytes32) {
        return _digest(quote);
    }

    /// @notice Whether the shop holds at least its revenue and every unclaimed credit.
    function solvent() external view returns (bool) {
        return address(this).balance >= revenue + totalEarnings;
    }

    // -------------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------------

    function _checkReferralBps(uint16 bps) private pure {
        if (bps > MAX_REFERRAL_BPS) revert ReferralBpsOutOfRange(bps);
    }

    function _acceptDefaultAdminTransfer() internal override {
        address previous = defaultAdmin();
        super._acceptDefaultAdminTransfer();
        _revokeRole(PAUSER_ROLE, previous);
        _grantRole(PAUSER_ROLE, defaultAdmin());
    }

    function _digest(Quote calldata quote) private view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    QUOTE_TYPEHASH,
                    quote.order,
                    quote.buyer,
                    quote.item,
                    quote.price,
                    quote.referrer,
                    quote.deadline
                )
            )
        );
    }
}
