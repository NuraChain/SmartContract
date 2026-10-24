// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title ArcadeVault
 * @notice Holds the native NURA that Arcade's players stake on paid tables. Every player's coin
 *         sits here in one of two states: free, which only its owner can move, and in play,
 *         which is locked into one game and leaves it only to that game's winners or back to its
 *         own players.
 *
 * A player deposits once and withdraws what is free whenever they like. Playing a game costs
 * them no transaction: they sign a `Stake` (EIP-712) for that one game, and the Arcade server,
 * holding REFEREE_ROLE, opens the game with every player's signature. The games themselves are
 * played on the Arcade server, so the referee is trusted to say who won - and nothing more:
 *
 *   - it can lock only stakes their owners signed, each signature once, before its deadline,
 *     at exactly the amount and fee the player signed;
 *   - it can pay a locked pot only to players of that same game, after the fee the players
 *     signed, and only with the secrets that open the commitments they signed (see `settle`);
 *   - it cannot touch a free balance, and nothing it does can stop a withdrawal.
 *
 * If the referee never pays a game, anybody can return every stake of it with `reclaim` once
 * `reclaimAfter` has passed since it was opened. Pausing stops new deposits and new games and
 * nothing else: games in play can still be paid, refunded or reclaimed, and every free balance
 * can still be withdrawn.
 *
 * @dev Deliberate omissions:
 *
 *      - No upgradeability. The rules players trust with their coin cannot be rewritten under
 *        them; a new version is a new address, and players withdraw from the old one.
 *      - No admin path to a player's balance or to a game in play. The admin sets the fee for
 *        games not yet opened (never above MAX_FEE_BPS), the ceiling on a stake, pauses, takes
 *        the fees, and can revoke the referee - which is the kill switch if its key leaks.
 *      - No outward transfer while settling. Winnings are credited to vault balances, so
 *        `settle`, `refund` and `reclaim` never hand control to anybody; only `withdraw` and
 *        `withdrawFees` send coin, after their state is written and behind nonReentrant.
 */
contract ArcadeVault is AccessControl, Pausable, ReentrancyGuard, EIP712 {
    /// @notice May open, settle and refund games. Meant for the Arcade server's key alone.
    bytes32 public constant REFEREE_ROLE = keccak256("REFEREE_ROLE");

    /// @notice May pause and unpause new deposits and new games.
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @notice The highest fee the admin can ever set: 10% of a pot.
    uint16 public constant MAX_FEE_BPS = 1_000;

    /// @notice The fewest and the most players a game can have.
    uint256 public constant MIN_SEATS = 2;
    uint256 public constant MAX_SEATS = 9;

    /// @notice The bounds on `reclaimAfter`, fixed at deploy. Shorter than a day would let a
    ///         losing player reclaim a game still being played; longer than thirty days would
    ///         leave a stake stuck behind a dead referee for longer than anybody would accept.
    uint256 public constant MIN_RECLAIM_AFTER = 1 days;
    uint256 public constant MAX_RECLAIM_AFTER = 30 days;

    /// @notice The longest a signed stake may still have to run when it is used. A player who
    ///         was asked to sign a stake good for a year would otherwise have handed out a year
    ///         of consent; Arcade asks for thirty minutes.
    uint256 public constant MAX_STAKE_LIFE = 1 days;

    uint256 private constant BPS = 10_000;

    bytes32 private constant STAKE_TYPEHASH = keccak256(
        "Stake(address player,string game,uint256 amount,uint16 feeBps,bytes32 commit,bytes32 nonce,uint64 deadline)"
    );

    /// @notice Where a game is. A game id is used once, whatever became of it.
    enum Status {
        None,
        Open,
        Settled,
        Refunded,
        Reclaimed
    }

    /**
     * @notice One player's place in a game, as `open` receives it.
     * @param player    Whose stake this is.
     * @param commit    The referee's commitment to its secret for this seat, `keccak256(abi.encode(secret))`.
     * @param nonce     Makes the signature good once.
     * @param deadline  Unix time after which the signature is no longer good.
     * @param signature The player's EIP-712 signature over their `Stake`, or an ERC-1271 one.
     */
    struct Seat {
        address player;
        bytes32 commit;
        bytes32 nonce;
        uint64 deadline;
        bytes signature;
    }

    struct Game {
        Status status;
        uint16 feeBps;
        uint64 openedAt;
        uint256 amount;
        bytes32 commits;
        address[] players;
    }

    /// @notice How long after `open` anybody may return a game's stakes with `reclaim`.
    uint256 public immutable reclaimAfter;

    /// @notice The fee a game opened now pays, in basis points of its pot.
    uint16 public fee;

    /// @notice The most one player may stake on one game.
    uint256 public maxStake;

    /// @notice Fees taken and not yet withdrawn, including the remainder a split leaves.
    uint256 public fees;

    /// @notice The sum of every free balance.
    uint256 public totalBalances;

    /// @notice The sum of every stake locked in a game.
    uint256 public totalLocked;

    /// @notice What each player can withdraw now.
    mapping(address player => uint256 amount) public balanceOf;

    /// @notice What each player has locked in games.
    mapping(address player => uint256 amount) public lockedOf;

    /// @notice Whether a player's signed stake has been used or cancelled.
    mapping(address player => mapping(bytes32 nonce => bool used)) public nonceUsed;

    mapping(bytes32 id => Game) private _games;

    event Deposited(address indexed player, uint256 amount);
    event Withdrawn(address indexed player, uint256 amount);
    event Cancelled(address indexed player, bytes32 indexed nonce);
    event Opened(bytes32 indexed id, string game, uint256 amount, uint16 feeBps, address[] players, bytes32[] commits);
    event Staked(bytes32 indexed id, address indexed player, uint256 amount);
    event Settled(bytes32 indexed id, uint256 winners, uint256 share, uint256 fee, bytes32[] secrets);
    event Paid(bytes32 indexed id, address indexed player, uint256 amount);
    event Refunded(bytes32 indexed id);
    event Reclaimed(bytes32 indexed id, address indexed by);
    event Returned(bytes32 indexed id, address indexed player, uint256 amount);
    event FeeChanged(uint16 previousFee, uint16 newFee);
    event MaxStakeChanged(uint256 previousMaxStake, uint256 newMaxStake);
    event FeesWithdrawn(address indexed to, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error FeeTooHigh(uint16 feeBps);
    error BadReclaimDelay(uint256 reclaimAfter);
    error InsufficientBalance(uint256 available, uint256 required);
    error InsufficientFees(uint256 available, uint256 required);
    error GameExists(bytes32 id);
    error GameNotOpen(bytes32 id);
    error BadSeatCount(uint256 seats);
    error StakeTooHigh(uint256 amount, uint256 maxStake);
    error FeeMismatch(uint16 signedFeeBps, uint16 currentFeeBps);
    error DuplicatePlayer(address player);
    error StakeExpired(address player, uint64 deadline);
    error StakeTooLong(address player, uint64 deadline);
    error NonceUsed(address player, bytes32 nonce);
    error InvalidSignature(address player);
    error StakeUnfunded(address player, uint256 available, uint256 required);
    error BadWinners(uint256 winners);
    error BadSecrets();
    error TooEarly(bytes32 id, uint256 due);

    /**
     * @param admin         Receives DEFAULT_ADMIN_ROLE and PAUSER_ROLE: the owner's wallet, or a multisig.
     * @param referee       The Arcade server's key. Receives REFEREE_ROLE.
     * @param fee_          The fee in basis points, at most MAX_FEE_BPS. 500 is 5%.
     * @param maxStake_     The most one player may stake on one game, in wei.
     * @param reclaimAfter_ Seconds after `open` from which anybody may `reclaim`, within the bounds.
     */
    constructor(
        address admin,
        address referee,
        uint16 fee_,
        uint256 maxStake_,
        uint256 reclaimAfter_
    ) EIP712("ArcadeVault", "1") {
        if (admin == address(0) || referee == address(0)) revert ZeroAddress();
        if (fee_ > MAX_FEE_BPS) revert FeeTooHigh(fee_);
        if (maxStake_ == 0) revert ZeroAmount();
        if (reclaimAfter_ < MIN_RECLAIM_AFTER || reclaimAfter_ > MAX_RECLAIM_AFTER) {
            revert BadReclaimDelay(reclaimAfter_);
        }

        reclaimAfter = reclaimAfter_;
        fee = fee_;
        maxStake = maxStake_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
        _grantRole(REFEREE_ROLE, referee);

        emit FeeChanged(0, fee_);
        emit MaxStakeChanged(0, maxStake_);
    }

    // -------------------------------------------------------------------------------
    // A player's own coin
    // -------------------------------------------------------------------------------

    /// @notice Adds the coin sent to the caller's free balance.
    function deposit() external payable whenNotPaused {
        _credit(_msgSender(), msg.value);
    }

    /// @notice A plain transfer is a deposit for the sender.
    receive() external payable whenNotPaused {
        _credit(_msgSender(), msg.value);
    }

    /**
     * @notice Sends `amount` of the caller's free balance to the caller.
     * @dev Never paused. The balance is written before the transfer, and nonReentrant is the
     *      second line of defence against a receiver that calls back in.
     */
    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();

        address player = _msgSender();
        uint256 available = balanceOf[player];
        if (available < amount) revert InsufficientBalance(available, amount);

        balanceOf[player] = available - amount;
        totalBalances -= amount;

        emit Withdrawn(player, amount);
        Address.sendValue(payable(player), amount);
    }

    /**
     * @notice Makes one of the caller's signed stakes unusable before its deadline.
     * @dev The referee only uses a stake while its player sits ready, but a signature lives on
     *      until its deadline wherever it was sent; this is how a player ends it themselves.
     */
    function cancel(bytes32 nonce) external {
        address player = _msgSender();
        nonceUsed[player][nonce] = true;
        emit Cancelled(player, nonce);
    }

    // -------------------------------------------------------------------------------
    // Games
    // -------------------------------------------------------------------------------

    /**
     * @notice Locks one game's stakes, all of them or none.
     * @param id     The game's id, used once ever.
     * @param game   The game's name as every player signed it, e.g. "ludo".
     * @param amount Each player's stake, in wei.
     * @param feeBps The fee every player signed; must be the vault's current `fee`.
     * @param seats  Every player with their signed stake, in seat order. The order is the one
     *               `settle`'s winners bitmask and secrets follow.
     * @dev Each player is refused by name - StakeExpired, StakeTooLong, NonceUsed,
     *      InvalidSignature, StakeUnfunded - so a referee that simulates this call first knows
     *      exactly whose stake stopped the game.
     */
    function open(
        bytes32 id,
        string calldata game,
        uint256 amount,
        uint16 feeBps,
        Seat[] calldata seats
    ) external onlyRole(REFEREE_ROLE) whenNotPaused {
        Game storage held = _games[id];
        if (held.status != Status.None) revert GameExists(id);

        uint256 count = seats.length;
        if (count < MIN_SEATS || count > MAX_SEATS) revert BadSeatCount(count);
        if (amount == 0) revert ZeroAmount();
        if (amount > maxStake) revert StakeTooHigh(amount, maxStake);
        if (feeBps != fee) revert FeeMismatch(feeBps, fee);

        bytes32 gameHash = keccak256(bytes(game));
        address[] memory players = new address[](count);
        bytes32[] memory commits = new bytes32[](count);

        for (uint256 i = 0; i < count; ++i) {
            address player = seats[i].player;
            for (uint256 j = 0; j < i; ++j) {
                if (players[j] == player) revert DuplicatePlayer(player);
            }

            _take(seats[i], gameHash, amount, feeBps);

            players[i] = player;
            commits[i] = seats[i].commit;
            emit Staked(id, player, amount);
        }

        uint256 pot = amount * count;
        totalBalances -= pot;
        totalLocked += pot;

        held.status = Status.Open;
        held.feeBps = feeBps;
        held.openedAt = uint64(block.timestamp);
        held.amount = amount;
        held.commits = keccak256(abi.encodePacked(commits));
        held.players = players;

        emit Opened(id, game, amount, feeBps, players, commits);
    }

    /**
     * @notice Pays one game: the pot less the fee, split evenly among the winners.
     * @param id      The game.
     * @param winners A bitmask over the game's seats, bit i for the player at seat i.
     * @param secrets The referee's secret for each seat, in seat order. Each must hash to the
     *                commit that seat's player signed, which is what makes the game's seed -
     *                and so its dice and cards - checkable by anybody once it is paid.
     * @dev The fee is the one the players signed. What the split leaves over goes to the fee,
     *      so the pot is always paid out to the last wei. Credits balances and sends nothing.
     */
    function settle(bytes32 id, uint256 winners, bytes32[] calldata secrets) external onlyRole(REFEREE_ROLE) {
        Game storage held = _games[id];
        if (held.status != Status.Open) revert GameNotOpen(id);

        uint256 count = held.players.length;
        if (winners == 0 || winners >> count != 0) revert BadWinners(winners);
        _checkSecrets(held.commits, secrets, count);

        uint256 pot = held.amount * count;
        uint256 share = (pot - (pot * held.feeBps) / BPS) / _bits(winners);

        held.status = Status.Settled;

        uint256 paid = _pay(id, held, winners, share);
        uint256 kept = pot - paid;
        totalLocked -= pot;
        totalBalances += paid;
        fees += kept;

        emit Settled(id, winners, share, kept, secrets);
    }

    /// @notice Gives every stake of one game back to its player, with no fee.
    function refund(bytes32 id) external onlyRole(REFEREE_ROLE) {
        _return(id, Status.Refunded);
        emit Refunded(id);
    }

    /**
     * @notice Gives every stake of a game that was never paid back to its player.
     * @dev Anybody may call it, from `reclaimAfter` after the game was opened. It moves coin
     *      only to the game's own players, so who calls it does not matter.
     */
    function reclaim(bytes32 id) external {
        Game storage held = _games[id];
        if (held.status != Status.Open) revert GameNotOpen(id);

        uint256 due = uint256(held.openedAt) + reclaimAfter;
        if (block.timestamp < due) revert TooEarly(id, due);

        _return(id, Status.Reclaimed);
        emit Reclaimed(id, _msgSender());
    }

    // -------------------------------------------------------------------------------
    // The owner
    // -------------------------------------------------------------------------------

    /// @notice Sets the fee for games opened from now on. Games already open keep theirs.
    function setFee(uint16 newFee) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newFee > MAX_FEE_BPS) revert FeeTooHigh(newFee);

        emit FeeChanged(fee, newFee);
        fee = newFee;
    }

    /// @notice Sets the most one player may stake on one game opened from now on.
    function setMaxStake(uint256 newMaxStake) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newMaxStake == 0) revert ZeroAmount();

        emit MaxStakeChanged(maxStake, newMaxStake);
        maxStake = newMaxStake;
    }

    /// @notice Sends fees taken to `to`.
    function withdrawFees(address to, uint256 amount) external nonReentrant onlyRole(DEFAULT_ADMIN_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (amount > fees) revert InsufficientFees(fees, amount);

        fees -= amount;

        emit FeesWithdrawn(to, amount);
        Address.sendValue(payable(to), amount);
    }

    /// @notice Stops new deposits and new games. Nothing else stops.
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Lets deposits and games start again.
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // -------------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------------

    /// @notice Where a game is, what each player staked, at what fee, and who played it.
    function gameOf(bytes32 id)
        external
        view
        returns (Status status, uint16 feeBps, uint64 openedAt, uint256 amount, address[] memory players)
    {
        Game storage held = _games[id];
        return (held.status, held.feeBps, held.openedAt, held.amount, held.players);
    }

    /// @notice The EIP-712 digest a player signs for one stake. For servers and tests.
    function stakeDigest(
        address player,
        string calldata game,
        uint256 amount,
        uint16 feeBps,
        bytes32 commit,
        bytes32 nonce,
        uint64 deadline
    ) external view returns (bytes32) {
        return _digest(player, keccak256(bytes(game)), amount, feeBps, commit, nonce, deadline);
    }

    /// @notice Whether the vault holds at least every free balance, every locked stake and the fees.
    function solvent() external view returns (bool) {
        return address(this).balance >= totalBalances + totalLocked + fees;
    }

    // -------------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------------

    function _credit(address player, uint256 amount) private {
        if (amount == 0) revert ZeroAmount();

        balanceOf[player] += amount;
        totalBalances += amount;

        emit Deposited(player, amount);
    }

    function _take(Seat calldata seat, bytes32 gameHash, uint256 amount, uint16 feeBps) private {
        address player = seat.player;
        if (player == address(0)) revert ZeroAddress();
        if (seat.deadline < block.timestamp) revert StakeExpired(player, seat.deadline);
        if (seat.deadline > block.timestamp + MAX_STAKE_LIFE) revert StakeTooLong(player, seat.deadline);
        if (nonceUsed[player][seat.nonce]) revert NonceUsed(player, seat.nonce);

        bytes32 digest = _digest(player, gameHash, amount, feeBps, seat.commit, seat.nonce, seat.deadline);
        if (!SignatureChecker.isValidSignatureNowCalldata(player, digest, seat.signature)) {
            revert InvalidSignature(player);
        }

        uint256 available = balanceOf[player];
        if (available < amount) revert StakeUnfunded(player, available, amount);

        nonceUsed[player][seat.nonce] = true;
        balanceOf[player] = available - amount;
        lockedOf[player] += amount;
    }

    function _checkSecrets(bytes32 expected, bytes32[] calldata secrets, uint256 count) private pure {
        if (secrets.length != count) revert BadSecrets();

        bytes32[] memory commits = new bytes32[](count);
        for (uint256 i = 0; i < count; ++i) {
            commits[i] = keccak256(abi.encode(secrets[i]));
        }
        if (keccak256(abi.encodePacked(commits)) != expected) revert BadSecrets();
    }

    function _pay(bytes32 id, Game storage held, uint256 winners, uint256 share) private returns (uint256 paid) {
        address[] storage players = held.players;
        uint256 count = players.length;
        uint256 amount = held.amount;

        for (uint256 i = 0; i < count; ++i) {
            address player = players[i];
            lockedOf[player] -= amount;

            if ((winners >> i) & 1 == 1) {
                balanceOf[player] += share;
                paid += share;
                emit Paid(id, player, share);
            }
        }
    }

    function _return(bytes32 id, Status status) private {
        Game storage held = _games[id];
        if (held.status != Status.Open) revert GameNotOpen(id);

        address[] storage players = held.players;
        uint256 count = players.length;
        uint256 amount = held.amount;

        held.status = status;

        for (uint256 i = 0; i < count; ++i) {
            address player = players[i];
            lockedOf[player] -= amount;
            balanceOf[player] += amount;
            emit Returned(id, player, amount);
        }

        uint256 pot = amount * count;
        totalLocked -= pot;
        totalBalances += pot;
    }

    function _digest(
        address player,
        bytes32 gameHash,
        uint256 amount,
        uint16 feeBps,
        bytes32 commit,
        bytes32 nonce,
        uint64 deadline
    ) private view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(STAKE_TYPEHASH, player, gameHash, amount, feeBps, commit, nonce, deadline))
        );
    }

    function _bits(uint256 mask) private pure returns (uint256 count) {
        while (mask != 0) {
            count += mask & 1;
            mask >>= 1;
        }
    }
}
