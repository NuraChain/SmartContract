// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {AccessControlDefaultAdminRules} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";

/**
 * @title ArcadeLooks
 * @notice The looks Arcade's players own - dice, pawns, card backs, avatar decorations, profile
 *         themes and the rest - as soulbound ERC-1155 tokens. One token id per look, at most one
 *         of each per wallet, minted by the Arcade server into its owner's wallet once the look
 *         is theirs, and burned by it when the look is taken back. The server pays the gas;
 *         players never sign anything.
 *
 * A look is paid for in `ArcadeShop`, and owned where the Arcade server keeps it. This contract
 * is the proof of it: a token in the owner's own wallet that the server put there and that
 * nobody, the owner included, can move. A look bought as a gift is minted straight into the
 * friend's wallet.
 *
 * Token ids come from the server's own item id, so there is no registry to keep in step with the
 * catalogue and nothing to look up before minting:
 *
 *   id = uint256(keccak256(bytes(itemId)))      // "dice.shiraz"; ethers: BigInt(ethers.id(itemId))
 *
 * Everything shown about a look - its name, picture, kind, collection, tier - lives in its
 * ERC-1155 metadata JSON, served under the `{id}` template.
 *
 * @dev Where this parts from `ArcadeAchievements`, on purpose:
 *
 *      - **Every token is soulbound.** There is no tradeable kind: a look is not resold.
 *      - **It can be burned, by the minter only.** The shop refunds a sale and takes its look back,
 *        and a token that outlived its refund would prove something untrue. Holders cannot burn.
 *      - **A wallet may be given a look again once it holds none of it.** Achievements are earned
 *        once for good; a refunded look can be bought again, so the guard is the balance, not a
 *        mark that it was ever held.
 *
 *      Deliberate omissions: no supply cap, no upgradeability, no royalties (nothing is resold),
 *      no `setApprovalForAll` use (approvals are harmless with every move refused, and kept so
 *      wallets that ask find the standard). One owner, handed over in two steps as the shop's is:
 *      `beginDefaultAdminTransfer`, then `acceptDefaultAdminTransfer` from the next owner.
 */
contract ArcadeLooks is ERC1155, AccessControlDefaultAdminRules {
    /// @notice May mint and burn. Meant for the Arcade server's minter wallet alone.
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    /// @notice Collection name. Not part of ERC-1155, but explorers and wallets display it.
    string public constant name = "Baziche Looks";

    /// @notice Collection symbol, read by explorers alongside `name`.
    string public constant symbol = "BZLOOK";

    /// @notice How many wallets hold each look now.
    mapping(uint256 id => uint256 holders) public holders;

    error ZeroAddress();
    error AlreadyHeld(address owner, uint256 id);
    error NotHeld(address owner, uint256 id);
    error Soulbound(uint256 id);

    /**
     * @param admin Receives DEFAULT_ADMIN_ROLE. Grant MINTER_ROLE to the server's minter wallet
     *              afterwards; the admin key need not, and should not, be a minter.
     * @param uri_  ERC-1155 metadata template, e.g. `https://baziche.com/api/nft/looks/{id}.json`.
     *              Clients replace `{id}` with the id as 64 lower-case hex digits.
     */
    constructor(address admin, string memory uri_) ERC1155(uri_) AccessControlDefaultAdminRules(0, admin) {}

    /**
     * @notice Mints look `id` to `owner`, while `owner` holds none of it.
     * @dev Reverts with AlreadyHeld on a repeat, so a server retry after a lost receipt mints
     *      nothing twice. A contract `owner` must implement IERC1155Receiver, or the mint reverts.
     */
    function mint(address owner, uint256 id) external onlyRole(MINTER_ROLE) {
        _give(owner, id);
        _mint(owner, id, 1, "");
    }

    /**
     * @notice Mints several looks to one owner in one transaction: a bundle, or what an owner
     *         already had before this contract was.
     * @dev All or nothing: one look already held reverts the whole batch with AlreadyHeld, and
     *      the server sends what remains. Ids repeated within a batch are refused the same way.
     */
    function mintBatch(address owner, uint256[] calldata ids) external onlyRole(MINTER_ROLE) {
        uint256[] memory ones = new uint256[](ids.length);

        for (uint256 i = 0; i < ids.length; ++i) {
            // Balances move only after the loop, so a look named twice would pass `_give` twice.
            for (uint256 j = 0; j < i; ++j) {
                if (ids[j] == ids[i]) revert AlreadyHeld(owner, ids[i]);
            }

            _give(owner, ids[i]);
            ones[i] = 1;
        }

        _mintBatch(owner, ids, ones, "");
    }

    /// @notice Takes look `id` back from `owner`: the shop refunded it, or it is no longer theirs.
    function burn(address owner, uint256 id) external onlyRole(MINTER_ROLE) {
        if (balanceOf(owner, id) == 0) revert NotHeld(owner, id);

        --holders[id];
        _burn(owner, id, 1);
    }

    /// @notice Replaces the `{id}` template.
    function setURI(string calldata newUri) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setURI(newUri);
    }

    /// @dev Checked before any token moves, and counted as it is given.
    function _give(address owner, uint256 id) private {
        if (owner == address(0)) revert ZeroAddress();
        if (balanceOf(owner, id) != 0) revert AlreadyHeld(owner, id);

        ++holders[id];
    }

    /// @dev Refuses every move between two wallets, single or batched. Mints and burns pass.
    function _update(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory values
    ) internal override {
        if (from != address(0) && to != address(0)) {
            revert Soulbound(ids.length == 0 ? 0 : ids[0]);
        }
        super._update(from, to, ids, values);
    }

    /// @dev Resolves `supportsInterface`, declared by both ERC1155 and AccessControl.
    function supportsInterface(
        bytes4 interfaceId
    ) public view override(ERC1155, AccessControlDefaultAdminRules) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
