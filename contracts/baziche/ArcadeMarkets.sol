// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControlDefaultAdminRules} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title ArcadeMarkets
 * @notice Pari-mutuel markets on Arcade's games, in native NURA. Many people back the outcomes of
 *         one game, each with a stake of their own; when the game is over, whoever backed the
 *         outcome that happened shares everything that was staked, by their stakes, less the fee
 *         the market names. Nobody is matched with anybody and nobody offers odds: the only money
 *         in a market is what its bettors put in.
 *
 * Every position comes with a `Ticket` (EIP-712) the Arcade server signs with a key that holds
 * OPERATOR_ROLE, for one bettor, one market, one outcome and one exact amount, good for a short
 * while. Who may bet, and how much, is the server's to decide, and the contract takes no stake
 * without a ticket. A ticket names its market's `Terms` by their hash and brings them with it: the
 * first ticket of a market opens it and the contract keeps the hash, so nobody pays to open a
 * market nobody bets on, and every later ticket must name and bring the same terms.
 *
 * Settling is the operator's, after the market closes, from the game's result as the Arcade
 * server recorded it. This contract cannot see a game, and trusts its operator for the result.
 * What the operator cannot do is send a stake anywhere but to its own market's bettors, and a
 * market the operator never settles can be expired by anybody a week after its close, which
 * refunds it. A market settled with winners can be claimed only once its dispute window has
 * passed (`disputeWindow`, the owner's, at most a day), and in that window the owner may overturn
 * the settlement, which refunds every stake: a leaked operator key that settles a market its own
 * way is caught there by whoever watches the chain against the server's records.
 *
 * Money leaves only through `claim`, pulled by each bettor for their own positions, and through
 * `withdrawFees`, for the owner. A winning position is paid its share of what is left to pay,
 * `left * stake / backingLeft`, both falling as each is paid, so the last winner to claim is paid
 * the exact remainder and no unit is left behind. A market refunds every stake in full, and takes
 * no fee, when it is cancelled or expires, when nobody backed the outcome that happened, or when
 * fewer people bet on it, or fewer of its outcomes were backed, than its terms ask for.
 *
 * @dev Deliberate omissions:
 *
 *      - No upgradeability. A new version is a new address; what a market recorded stays where it
 *        is.
 *      - No sweep. A share nobody claims stays theirs for as long as the contract exists.
 *      - No `receive`. Coin comes in through `place`; a plain transfer is refused rather than
 *        left nobody's.
 *      - No odds, no house and no liquidity: a market pays out exactly what was staked in it.
 *      - No path from the operator to a stake but `settle` and `cancel`, and no path from the
 *        owner to a stake but `overturn`, which only gives stakes back; the owner takes only
 *        `fees`.
 *      - One owner, handed over in two steps, as the vault and the shop are:
 *        `beginDefaultAdminTransfer`, then `acceptDefaultAdminTransfer` from the next owner;
 *        PAUSER_ROLE goes with it. Pausing stops new positions and nothing else.
 *      - Coin leaves only after the state it settles is written, behind nonReentrant. `place`
 *        hands control to nobody.
 */
contract ArcadeMarkets is AccessControlDefaultAdminRules, Pausable, ReentrancyGuard, EIP712 {
    /// @notice May sign tickets, settle markets and cancel them. Meant for the Arcade server's key.
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    /// @notice May pause and unpause new positions.
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @notice The most fee a market's terms may name: 5% of its pool.
    uint16 public constant MAX_FEE_BPS = 500;

    /// @notice The most outcomes one market may have.
    uint8 public constant MAX_OUTCOMES = 16;

    /// @notice The furthest ahead a market may close, at its first ticket.
    uint256 public constant MAX_MARKET_LIFE = 1 days;

    /// @notice The longest a ticket may still have to run when it is used.
    uint256 public constant MAX_TICKET_LIFE = 1 hours;

    /// @notice How long after its close a market nobody settled may be expired, and refunded.
    uint256 public constant EXPIRY = 7 days;

    /// @notice The longest the owner may hold a settled market's winners from claiming.
    uint256 public constant MAX_DISPUTE_WINDOW = 1 days;

    uint256 private constant BPS = 10_000;

    bytes32 private constant TERMS_TYPEHASH = keccak256(
        "Terms(bytes32 market,bytes32 game,uint8 outcomes,uint64 closesAt,uint16 feeBps,uint256 maxStake,uint256 maxPerBettor,uint256 maxPool,uint32 minBettors,uint8 minOutcomes)"
    );

    bytes32 private constant TICKET_TYPEHASH = keccak256(
        "Ticket(bytes32 id,bytes32 market,bytes32 terms,address bettor,uint8 outcome,uint256 amount,uint64 deadline)"
    );

    /**
     * @notice Where a market is. `Settled` pays the backers of its outcome; `Refunded` (settled,
     *         but nobody backed the outcome, or too few bettors or backed outcomes), `Cancelled`
     *         and `Expired` give every stake back.
     */
    enum State {
        None,
        Open,
        Settled,
        Refunded,
        Cancelled,
        Expired
    }

    /**
     * @notice What a market is, fixed when its first ticket is placed.
     * @param market       The market's id, as the server made it.
     * @param game         The game it is about, as the server names it.
     * @param outcomes     How many outcomes it has, from 2 to MAX_OUTCOMES; an outcome is an index.
     * @param closesAt     Unix time from which no position is taken.
     * @param feeBps       The part of the pool taken as a fee when a winner is paid, at most MAX_FEE_BPS.
     * @param maxStake     The most one position may stake, in wei.
     * @param maxPerBettor The most one bettor may stake in this market, in wei.
     * @param maxPool      The most the whole market may hold, in wei.
     * @param minBettors   The fewest distinct bettors for a winner to be paid, at least 2.
     * @param minOutcomes  The fewest outcomes backed for a winner to be paid, at least 2.
     */
    struct Terms {
        bytes32 market;
        bytes32 game;
        uint8 outcomes;
        uint64 closesAt;
        uint16 feeBps;
        uint256 maxStake;
        uint256 maxPerBettor;
        uint256 maxPool;
        uint32 minBettors;
        uint8 minOutcomes;
    }

    /**
     * @notice One position, as the operator allowed it.
     * @param id       The position's id, used once ever.
     * @param market   The market it is in.
     * @param terms    The hash of that market's terms.
     * @param bettor   The only address that may place it.
     * @param outcome  The outcome it backs.
     * @param amount   Exactly what `place` must be sent, in wei.
     * @param deadline Unix time after which the ticket is no longer good.
     */
    struct Ticket {
        bytes32 id;
        bytes32 market;
        bytes32 terms;
        address bettor;
        uint8 outcome;
        uint256 amount;
        uint64 deadline;
    }

    /**
     * @notice A market: the hash of its terms, what settling it needs of them, and its books.
     * @dev The limits are not kept: every ticket brings the terms it names, so they are read from
     *      the call. `left` and `backingLeft` are set by `settle` and fall with every winner's
     *      claim: what is still to be paid to the winners, and the winners' stakes not yet claimed.
     *      A settled market's fee is `pool * feeBps / 10_000`, and its winners claim from
     *      `claimableAt`.
     */
    struct Market {
        bytes32 terms;
        State state;
        uint8 outcomes;
        uint8 winner;
        uint8 backedOutcomes;
        uint8 minOutcomes;
        uint16 feeBps;
        uint32 bettors;
        uint32 minBettors;
        uint64 closesAt;
        uint64 claimableAt;
        uint256 pool;
        uint256 left;
        uint256 backingLeft;
    }

    struct Position {
        bytes32 market;
        address bettor;
        uint8 outcome;
        bool claimed;
        uint256 amount;
    }

    /// @notice The key tickets are signed with, as last set by the constructor or `setOperator`.
    address public operator;

    /// @notice Every stake of a market not yet resolved, and every share and refund not yet claimed.
    uint256 public owed;

    /// @notice The owner's: the fees of every market settled, less what was withdrawn.
    uint256 public fees;

    /// @notice How long a market settled from now on holds its winners from claiming, while the
    ///         owner may overturn it.
    uint64 public disputeWindow;

    mapping(bytes32 market => Market) private _markets;
    mapping(bytes32 market => mapping(uint8 outcome => uint256 staked)) private _backing;
    mapping(bytes32 market => mapping(address bettor => uint256 staked)) private _staked;
    mapping(bytes32 ticket => Position) private _positions;

    event MarketOpened(bytes32 indexed market, bytes32 indexed game, bytes32 terms, uint8 outcomes, uint64 closesAt, uint16 feeBps);
    event Placed(bytes32 indexed ticket, bytes32 indexed market, address indexed bettor, uint8 outcome, uint256 amount);
    event Settled(bytes32 indexed market, uint8 outcome, uint256 pool, uint256 fee, uint64 claimableAt);
    event Refunded(bytes32 indexed market, uint8 outcome);
    event Cancelled(bytes32 indexed market);
    event Expired(bytes32 indexed market);
    event Overturned(bytes32 indexed market);
    event Claimed(bytes32 indexed ticket, address indexed bettor, uint256 amount);
    event FeesWithdrawn(address indexed to, uint256 amount);
    event Funded(address indexed from, uint256 amount);
    event OperatorChanged(address indexed previousOperator, address indexed newOperator);
    event DisputeWindowChanged(uint64 previousWindow, uint64 newWindow);

    error ZeroAddress();
    error ZeroAmount();
    error InvalidTerms(bytes32 market);
    error TermsMismatch(bytes32 market, bytes32 terms);
    error TicketUsed(bytes32 ticket);
    error NotBettor(bytes32 ticket, address bettor);
    error WrongAmount(bytes32 ticket, uint256 amount, uint256 sent);
    error TicketExpired(bytes32 ticket, uint64 deadline);
    error TicketTooLong(bytes32 ticket, uint64 deadline);
    error InvalidSignature(bytes32 ticket);
    error MarketClosed(bytes32 market);
    error OutcomeOutOfRange(bytes32 market, uint8 outcome);
    error StakeTooLarge(bytes32 ticket, uint256 amount, uint256 most);
    error BettorLimit(bytes32 ticket, uint256 staked, uint256 most);
    error PoolLimit(bytes32 market, uint256 pool, uint256 most);
    error UnknownMarket(bytes32 market);
    error MarketResolved(bytes32 market, State state);
    error MarketOpen(bytes32 market);
    error TooEarly(bytes32 market, uint256 at);
    error NoTickets();
    error UnknownTicket(bytes32 ticket);
    error AlreadyClaimed(bytes32 ticket);
    error NothingOwed(bytes32 ticket);
    error NotYetClaimable(bytes32 market, uint64 claimableAt);
    error NotSettled(bytes32 market, State state);
    error DisputeClosed(bytes32 market, uint64 claimableAt);
    error DisputeWindowTooLong(uint64 window);
    error InsufficientFees(uint256 available, uint256 required);

    /**
     * @param admin          The owner: receives DEFAULT_ADMIN_ROLE and PAUSER_ROLE. The owner's wallet, or a multisig.
     * @param operator_      The Arcade server's key. Receives OPERATOR_ROLE.
     * @param disputeWindow_ How long a settled market's winners wait to claim, in seconds, at most MAX_DISPUTE_WINDOW.
     */
    constructor(address admin, address operator_, uint64 disputeWindow_)
        AccessControlDefaultAdminRules(0, admin)
        EIP712("ArcadeMarkets", "1")
    {
        if (operator_ == address(0)) revert ZeroAddress();
        _checkDisputeWindow(disputeWindow_);

        operator = operator_;
        disputeWindow = disputeWindow_;

        _grantRole(PAUSER_ROLE, admin);
        _grantRole(OPERATOR_ROLE, operator_);

        emit OperatorChanged(address(0), operator_);
        emit DisputeWindowChanged(0, disputeWindow_);
    }

    // -------------------------------------------------------------------------------
    // Positions
    // -------------------------------------------------------------------------------

    /**
     * @notice Stakes exactly a ticket's amount on its outcome, and opens its market with the
     *         first one.
     * @param terms     The market's terms, which must be the ones the ticket names by their hash.
     * @param ticket    The position, its bettor, its amount and its deadline.
     * @param signature The operator's signature over `ticket`.
     * @dev Refuses by name - TicketUsed, NotBettor, ZeroAmount, WrongAmount, TicketExpired,
     *      TicketTooLong, InvalidSignature, TermsMismatch, InvalidTerms, MarketClosed,
     *      OutcomeOutOfRange, StakeTooLarge, BettorLimit, PoolLimit - so a wallet that simulates
     *      the call first says why. Sends nothing.
     */
    function place(Terms calldata terms, Ticket calldata ticket, bytes calldata signature) external payable whenNotPaused {
        _checkTicket(ticket, signature);
        _take(_marketFor(terms, ticket), terms, ticket);
    }

    /**
     * @notice Pays the caller everything their positions are owed: a winner's share, or a stake
     *         back from a market that refunds.
     * @param tickets The caller's own positions, one or many.
     * @dev Never paused. Refuses by name - NoTickets, UnknownTicket, NotBettor, AlreadyClaimed,
     *      MarketOpen, NothingOwed, NotYetClaimable - and pays nothing unless every position named
     *      is owed something now. Every position is marked before the coin leaves, and nonReentrant is the
     *      second line of defence.
     */
    function claim(bytes32[] calldata tickets) external nonReentrant {
        if (tickets.length == 0) revert NoTickets();

        address bettor = _msgSender();
        uint256 total = 0;
        for (uint256 i = 0; i < tickets.length; ++i) {
            total += _claim(tickets[i], bettor);
        }

        Address.sendValue(payable(bettor), total);
    }

    // -------------------------------------------------------------------------------
    // Resolving a market
    // -------------------------------------------------------------------------------

    /**
     * @notice Names the outcome that happened, once the market has closed. Its backers share the
     *         pool less the fee, from the end of the dispute window; or every stake goes back, with
     *         no fee and at once, when nobody backed it, or fewer people bet, or fewer outcomes were
     *         backed, than the terms ask for.
     */
    function settle(bytes32 key, uint8 outcome) external onlyRole(OPERATOR_ROLE) {
        Market storage market = _resolvable(key);
        if (block.timestamp < market.closesAt) revert MarketOpen(key);
        if (outcome >= market.outcomes) revert OutcomeOutOfRange(key, outcome);

        uint256 backing = _backing[key][outcome];
        market.winner = outcome;

        if (backing == 0 || market.bettors < market.minBettors || market.backedOutcomes < market.minOutcomes) {
            market.state = State.Refunded;
            emit Refunded(key, outcome);
            return;
        }

        uint256 fee = (market.pool * market.feeBps) / BPS;
        uint64 claimableAt = uint64(block.timestamp) + disputeWindow;
        market.state = State.Settled;
        market.claimableAt = claimableAt;
        market.left = market.pool - fee;
        market.backingLeft = backing;
        owed -= fee;
        fees += fee;

        emit Settled(key, outcome, market.pool, fee, claimableAt);
    }

    /**
     * @notice Undoes a settlement in its dispute window, and gives every stake back in full, the
     *         fee with it. For a result the operator should not have named.
     * @dev Nobody can have claimed from it yet, so its fee is what the pool and `left` differ by.
     *      A fee already withdrawn has to be put back with `fund` first.
     */
    function overturn(bytes32 key) external onlyRole(DEFAULT_ADMIN_ROLE) {
        Market storage market = _markets[key];
        if (market.state != State.Settled) revert NotSettled(key, market.state);
        if (block.timestamp >= market.claimableAt) revert DisputeClosed(key, market.claimableAt);

        uint256 fee = market.pool - market.left;
        if (fee > fees) revert InsufficientFees(fees, fee);

        fees -= fee;
        owed += fee;
        market.state = State.Cancelled;

        emit Overturned(key);
    }

    /// @notice Gives every stake of a market back, for a game that ended with no result.
    function cancel(bytes32 key) external onlyRole(OPERATOR_ROLE) {
        Market storage market = _resolvable(key);
        market.state = State.Cancelled;

        emit Cancelled(key);
    }

    /// @notice Gives every stake back of a market nobody settled, a week after its close. Anybody may.
    function expire(bytes32 key) external {
        Market storage market = _resolvable(key);
        uint256 at = uint256(market.closesAt) + EXPIRY;
        if (block.timestamp < at) revert TooEarly(key, at);

        market.state = State.Expired;

        emit Expired(key);
    }

    // -------------------------------------------------------------------------------
    // The owner
    // -------------------------------------------------------------------------------

    /// @notice Sends fees to `to`. No stake, share or refund is ever a fee.
    function withdrawFees(address to, uint256 amount) external nonReentrant onlyRole(DEFAULT_ADMIN_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (amount > fees) revert InsufficientFees(fees, amount);

        fees -= amount;

        emit FeesWithdrawn(to, amount);
        Address.sendValue(payable(to), amount);
    }

    /// @notice Adds the coin sent to fees, so a settlement can be overturned after its fee was withdrawn.
    function fund() external payable onlyRole(DEFAULT_ADMIN_ROLE) {
        if (msg.value == 0) revert ZeroAmount();

        fees += msg.value;

        emit Funded(_msgSender(), msg.value);
    }

    /// @notice Sets how long the winners of markets settled from now on wait to claim, at most a day.
    function setDisputeWindow(uint64 newWindow) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _checkDisputeWindow(newWindow);

        emit DisputeWindowChanged(disputeWindow, newWindow);
        disputeWindow = newWindow;
    }

    /**
     * @notice Moves OPERATOR_ROLE from the current `operator` to `newOperator` in one call.
     * @dev Tickets the old key signed stop being good at once, and it can settle nothing more. Any
     *      other operator granted with `grantRole` keeps its role; `revokeRole` takes it.
     */
    function setOperator(address newOperator) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newOperator == address(0)) revert ZeroAddress();

        address previous = operator;
        operator = newOperator;
        _revokeRole(OPERATOR_ROLE, previous);
        _grantRole(OPERATOR_ROLE, newOperator);

        emit OperatorChanged(previous, newOperator);
    }

    /// @notice Stops new positions. Claims, settling, cancelling and expiring carry on.
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Lets positions be placed again.
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // -------------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------------

    /// @notice One market, its terms and its books. A state of None means no ticket was ever placed in it.
    function marketOf(bytes32 key) external view returns (Market memory) {
        return _markets[key];
    }

    /// @notice How much is staked on one outcome of a market.
    function backingOf(bytes32 key, uint8 outcome) external view returns (uint256) {
        return _backing[key][outcome];
    }

    /// @notice How much one bettor has staked in a market.
    function stakedOf(bytes32 key, address bettor) external view returns (uint256) {
        return _staked[key][bettor];
    }

    /// @notice One position: its market, its bettor, its outcome, its stake and whether it was
    ///         claimed. A bettor of the zero address means that ticket was never placed.
    function positionOf(bytes32 ticket)
        external
        view
        returns (bytes32 market, address bettor, uint8 outcome, uint256 amount, bool claimed)
    {
        Position storage position = _positions[ticket];
        return (position.market, position.bettor, position.outcome, position.amount, position.claimed);
    }

    /// @notice What claiming one position pays, once its market's dispute window has passed:
    ///         nothing while its market is open, for a position that lost, or for one already claimed.
    function payoutOf(bytes32 ticket) external view returns (uint256) {
        Position storage position = _positions[ticket];
        if (position.bettor == address(0) || position.claimed) return 0;

        Market storage market = _markets[position.market];
        if (market.state == State.Open) return 0;
        if (market.state != State.Settled) return position.amount;
        if (position.outcome != market.winner) return 0;

        return (market.left * position.amount) / market.backingLeft;
    }

    /// @notice The hash a ticket names its market's terms by. For servers and tests.
    function termsHash(Terms calldata terms) external pure returns (bytes32) {
        return _termsHash(terms);
    }

    /// @notice The EIP-712 digest the operator signs for one ticket. For servers and tests.
    function ticketDigest(Ticket calldata ticket) external view returns (bytes32) {
        return _ticketDigest(ticket);
    }

    /// @notice Whether the contract holds at least every stake, share and refund it owes, and its fees.
    function solvent() external view returns (bool) {
        return address(this).balance >= owed + fees;
    }

    // -------------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------------

    function _checkTicket(Ticket calldata ticket, bytes calldata signature) private view {
        bytes32 id = ticket.id;
        if (_positions[id].bettor != address(0)) revert TicketUsed(id);
        if (ticket.bettor != _msgSender()) revert NotBettor(id, ticket.bettor);
        if (ticket.amount == 0) revert ZeroAmount();
        if (msg.value != ticket.amount) revert WrongAmount(id, ticket.amount, msg.value);
        if (ticket.deadline < block.timestamp) revert TicketExpired(id, ticket.deadline);
        if (ticket.deadline > block.timestamp + MAX_TICKET_LIFE) revert TicketTooLong(id, ticket.deadline);

        (address signer, ECDSA.RecoverError failure,) = ECDSA.tryRecoverCalldata(_ticketDigest(ticket), signature);
        if (failure != ECDSA.RecoverError.NoError || !hasRole(OPERATOR_ROLE, signer)) revert InvalidSignature(id);
    }

    /// @dev The ticket's market, opened from `terms` when this is its first ticket, and taking positions.
    function _marketFor(Terms calldata terms, Ticket calldata ticket) private returns (Market storage market) {
        bytes32 key = ticket.market;
        if (terms.market != key || _termsHash(terms) != ticket.terms) revert TermsMismatch(key, ticket.terms);

        market = _markets[key];
        if (market.state == State.None) {
            _open(market, terms, ticket.terms);
        } else if (market.terms != ticket.terms) {
            revert TermsMismatch(key, ticket.terms);
        }

        if (market.state != State.Open || block.timestamp >= market.closesAt) revert MarketClosed(key);
        if (ticket.outcome >= market.outcomes) revert OutcomeOutOfRange(key, ticket.outcome);
    }

    function _take(Market storage market, Terms calldata terms, Ticket calldata ticket) private {
        bytes32 key = ticket.market;
        address bettor = ticket.bettor;
        uint256 amount = ticket.amount;
        if (amount > terms.maxStake) revert StakeTooLarge(ticket.id, amount, terms.maxStake);

        uint256 before = _staked[key][bettor];
        if (before + amount > terms.maxPerBettor) revert BettorLimit(ticket.id, before + amount, terms.maxPerBettor);
        if (market.pool + amount > terms.maxPool) revert PoolLimit(key, market.pool + amount, terms.maxPool);

        if (before == 0) market.bettors += 1;
        if (_backing[key][ticket.outcome] == 0) market.backedOutcomes += 1;
        _staked[key][bettor] = before + amount;
        _backing[key][ticket.outcome] += amount;
        market.pool += amount;
        owed += amount;

        _positions[ticket.id] = Position({market: key, bettor: bettor, outcome: ticket.outcome, claimed: false, amount: amount});

        emit Placed(ticket.id, key, bettor, ticket.outcome, amount);
    }

    function _open(Market storage market, Terms calldata terms, bytes32 hash) private {
        if (
            terms.outcomes < 2 || terms.outcomes > MAX_OUTCOMES || terms.minOutcomes < 2
                || terms.minOutcomes > terms.outcomes || terms.minBettors < 2 || terms.feeBps > MAX_FEE_BPS
                || terms.maxStake == 0 || terms.maxPerBettor == 0 || terms.maxPool == 0
                || terms.closesAt > block.timestamp + MAX_MARKET_LIFE
        ) revert InvalidTerms(terms.market);

        market.terms = hash;
        market.state = State.Open;
        market.outcomes = terms.outcomes;
        market.minOutcomes = terms.minOutcomes;
        market.feeBps = terms.feeBps;
        market.minBettors = terms.minBettors;
        market.closesAt = terms.closesAt;

        emit MarketOpened(terms.market, terms.game, hash, terms.outcomes, terms.closesAt, terms.feeBps);
    }

    function _claim(bytes32 id, address bettor) private returns (uint256 amount) {
        Position storage position = _positions[id];
        if (position.bettor == address(0)) revert UnknownTicket(id);
        if (position.bettor != bettor) revert NotBettor(id, position.bettor);
        if (position.claimed) revert AlreadyClaimed(id);

        Market storage market = _markets[position.market];
        if (market.state == State.Open) revert MarketOpen(position.market);

        if (market.state == State.Settled) {
            if (position.outcome != market.winner) revert NothingOwed(id);
            if (block.timestamp < market.claimableAt) revert NotYetClaimable(position.market, market.claimableAt);

            uint256 backingLeft = market.backingLeft;
            amount = (market.left * position.amount) / backingLeft;
            market.left -= amount;
            market.backingLeft = backingLeft - position.amount;
        } else {
            amount = position.amount;
        }

        position.claimed = true;
        owed -= amount;

        emit Claimed(id, bettor, amount);
    }

    function _checkDisputeWindow(uint64 window) private pure {
        if (window > MAX_DISPUTE_WINDOW) revert DisputeWindowTooLong(window);
    }

    function _resolvable(bytes32 key) private view returns (Market storage market) {
        market = _markets[key];
        if (market.state == State.None) revert UnknownMarket(key);
        if (market.state != State.Open) revert MarketResolved(key, market.state);
    }

    function _acceptDefaultAdminTransfer() internal override {
        address previous = defaultAdmin();
        super._acceptDefaultAdminTransfer();
        _revokeRole(PAUSER_ROLE, previous);
        _grantRole(PAUSER_ROLE, defaultAdmin());
    }

    // Both structs hold static fields alone, so encoding the struct is encoding each field in
    // turn: the EIP-712 struct hash, in fewer stack slots than naming every field.

    function _termsHash(Terms calldata terms) private pure returns (bytes32) {
        return keccak256(abi.encode(TERMS_TYPEHASH, terms));
    }

    function _ticketDigest(Ticket calldata ticket) private view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(TICKET_TYPEHASH, ticket)));
    }
}
