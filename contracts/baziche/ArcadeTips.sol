// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControlDefaultAdminRules} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title ArcadeTips
 * @notice Passes native NURA from somebody watching a game on Arcade to a player of it, and
 *         records the gift under the id the Arcade server gave it. The whole amount reaches the
 *         player in the call that sends it; the contract keeps nothing and takes no fee.
 *
 * A gift is recorded under its giver and its id, `tipOf(from, id)`. The server makes the id when
 * it prepares the gift and confirms the gift by asking about it, never by a hash the page reports,
 * so a transaction the wallet sped up or re-priced is found all the same, and an id is paid once.
 * A call carries the deadline the server gave it and is refused after it, so a gift the server let
 * lapse cannot be made late, behind its back.
 * It is keyed by the giver as well as the id, so nobody can spend a giver's id first: the same
 * call sent from another wallet is recorded under that wallet, and the real gift still goes
 * through.
 *
 * @dev Deliberate omissions:
 *
 *      - No balance to speak of, so nothing to withdraw, claim or refund: a gift is forwarded in
 *        the call that makes it, or the call reverts and nothing moved. Coin forced in by another
 *        contract's self-destruct stays here; nothing can move it, and nothing counts on it.
 *      - No `receive`. A plain transfer is refused rather than left nobody's.
 *      - No signature from the server. Whom a giver may give to is the server's to decide before
 *        it hands out the call, and it reads what was recorded before it believes a gift; an id a
 *        giver spends on their own harms nobody but the giver.
 *      - No upgradeability. A new version is a new address; what a gift recorded stays where it
 *        is.
 *      - One owner, handed over in two steps (`beginDefaultAdminTransfer`, then
 *        `acceptDefaultAdminTransfer` from the next owner), with PAUSER_ROLE going with it. The
 *        owner may stop new gifts, and that is all the owner may do.
 */
contract ArcadeTips is AccessControlDefaultAdminRules, Pausable {
    /// @notice May pause and unpause new gifts.
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    struct Tip {
        address to;
        uint64 givenAt;
        uint256 amount;
    }

    mapping(address from => mapping(bytes32 id => Tip)) private _tips;

    event Tipped(address indexed from, bytes32 indexed id, address indexed to, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error SelfTip();
    error TipUsed(address from, bytes32 id);
    error TipExpired(address from, bytes32 id, uint64 deadline);

    /// @param admin The owner: receives DEFAULT_ADMIN_ROLE and PAUSER_ROLE. The owner's wallet, or a multisig.
    constructor(address admin) AccessControlDefaultAdminRules(0, admin) {
        _grantRole(PAUSER_ROLE, admin);
    }

    /**
     * @notice Sends everything this call carries to `to`, recorded under the caller and `id`.
     * @param id       The gift's id, as the Arcade server made it. Each giver uses an id once.
     * @param to       The player who receives it.
     * @param deadline Unix time after which the call is refused.
     * @dev Refuses by name - ZeroAddress, SelfTip, ZeroAmount, TipExpired, TipUsed - so a wallet
     *      that simulates the call first says why. The record is written before the coin leaves,
     *      so a receiver that calls back in finds it; a receiver that refuses the coin reverts the
     *      whole gift.
     */
    function tip(bytes32 id, address to, uint64 deadline) external payable whenNotPaused {
        address from = _msgSender();
        if (to == address(0)) revert ZeroAddress();
        if (to == from) revert SelfTip();
        if (msg.value == 0) revert ZeroAmount();
        if (deadline < block.timestamp) revert TipExpired(from, id, deadline);

        Tip storage record = _tips[from][id];
        if (record.to != address(0)) revert TipUsed(from, id);

        record.to = to;
        record.givenAt = uint64(block.timestamp);
        record.amount = msg.value;

        emit Tipped(from, id, to, msg.value);
        Address.sendValue(payable(to), msg.value);
    }

    /// @notice Stops new gifts.
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Lets gifts start again.
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    /// @notice One gift: whom it went to, how much, and when. A receiver of the zero address means
    ///         that giver never used that id.
    function tipOf(address from, bytes32 id) external view returns (address to, uint256 amount, uint64 givenAt) {
        Tip storage record = _tips[from][id];
        return (record.to, record.amount, record.givenAt);
    }

    function _acceptDefaultAdminTransfer() internal override {
        address previous = defaultAdmin();
        super._acceptDefaultAdminTransfer();
        _revokeRole(PAUSER_ROLE, previous);
        _grantRole(PAUSER_ROLE, defaultAdmin());
    }
}
