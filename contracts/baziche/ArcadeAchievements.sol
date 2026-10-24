// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {ERC1155URIStorage} from "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155URIStorage.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title ArcadeAchievements
 * @notice The Arcade's achievements as ERC-1155 tokens. One token id per
 *         achievement, at most one of each per player, minted by the Arcade backend when a
 *         player earns it. The backend pays the gas; players never sign anything.
 *
 * Token ids come from the backend's own achievement key, so there is no registry to keep in
 * sync and nothing to look up before minting:
 *
 *   id = uint256(keccak256(bytes(key)))      // ethers: BigInt(ethers.id(key))
 *
 * The only rule this contract keeps per achievement is whether it can move. Soulbound ones
 * cannot once minted, which is what lets a wallet holding one prove it earned it; tradeable ones
 * are ordinary ERC-1155 tokens. The rule is fixed from the first award on, see `defineAchievement`.
 *
 * Everything shown about an achievement - name, description, rarity, free-form fields, image,
 * 3D model - lives in its ERC-1155 metadata JSON, not in this contract:
 *
 *   {
 *     "name": "Ludo Legend",
 *     "description": "Won 1000 games of Ludo.",
 *     "image": "ipfs://<cid>/medal.png",            // PNG, or SVG (linked or data:image/svg+xml)
 *     "animation_url": "ipfs://<cid>/medal.glb",    // 3D model, .glb or .gltf
 *     "attributes": [
 *       { "trait_type": "Rarity", "value": "Legendary" },
 *       { "trait_type": "Game", "value": "Ludo" }
 *     ]
 *   }
 *
 * `uri(id)` returns the achievement's own URI when it has one - `ipfs://`, `ar://`, `https://`,
 * or a whole `data:application/json;base64,...` document for fully on-chain metadata - and the
 * `{id}` template otherwise. Media files belong on IPFS or a server: storage costs ~20k gas per
 * 32 bytes, so a small inline SVG is affordable and a PNG or 3D model is not.
 *
 * @dev Deliberate omissions:
 *
 *      - No burn and no revoke. A soulbound token that an admin can take back proves only
 *        that the admin has not taken it back yet.
 *      - No supply cap. Every player who reaches an achievement gets it; `achievements(id)`
 *        reports how many have.
 *      - No upgradeability. The soulbound rule holders rely on cannot be rewritten under them.
 */
contract ArcadeAchievements is ERC1155URIStorage, AccessControl {
    /// @notice May define achievements and award them. Meant for the backend's relayer wallet.
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    struct Achievement {
        bool defined;
        bool soulbound;
        uint64 awarded;
    }

    /// @notice Collection name. Not part of ERC-1155, but explorers and wallets display it.
    string public constant name = "Nura Arcade Achievements";

    /// @notice Collection symbol, read by explorers alongside `name`.
    string public constant symbol = "ARCADE";

    /// @notice Whether defined, transfer rule and number of players awarded, per achievement id.
    mapping(uint256 id => Achievement) public achievements;

    /// @notice Whether `player` was ever awarded `id`. Survives transferring a tradeable one away.
    mapping(address player => mapping(uint256 id => bool)) public earned;

    /// @notice Emitted on every define, carrying the key so ids can be mapped back from logs.
    event AchievementDefined(uint256 indexed id, string key, bool soulbound);

    error ZeroAddress();
    error UnknownAchievement(uint256 id);
    error AchievementLocked(uint256 id);
    error AlreadyEarned(address player, uint256 id);
    error Soulbound(uint256 id);

    /**
     * @param admin Receives DEFAULT_ADMIN_ROLE and MINTER_ROLE. Grant MINTER_ROLE to the
     *              backend's wallet afterwards; the admin key need not stay a minter.
     * @param uri_  ERC-1155 metadata template, e.g. `https://arcade.example/nft/{id}.json`.
     *              Clients replace `{id}` with the id as 64 lower-case hex digits.
     */
    constructor(address admin, string memory uri_) ERC1155(uri_) {
        if (admin == address(0)) revert ZeroAddress();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
    }

    /**
     * @notice Creates the achievement `key`, or rewrites it while nobody has been awarded it.
     * @dev Repeatable until the first award, then locked for good. That makes it safe for two
     *      backend workers to define the same new achievement at once, and lets a wrong transfer
     *      rule be corrected before anyone holds one. After the first award the rule is part of
     *      what holders were given, so it can no longer change.
     *
     *      A backend should define only while `achievements(id).defined` is false, and treat
     *      AchievementLocked as "already defined and live": another worker may have awarded
     *      it between this worker's read and its define.
     * @param metadataURI The achievement's metadata JSON (see the contract note), or empty to
     *                    fall back to the `{id}` template.
     * @return id The token id, `uint256(keccak256(bytes(key)))`.
     */
    function defineAchievement(
        string calldata key,
        bool soulbound,
        string calldata metadataURI
    ) external onlyRole(MINTER_ROLE) returns (uint256 id) {
        id = uint256(keccak256(bytes(key)));
        if (achievements[id].awarded != 0) revert AchievementLocked(id);

        achievements[id] = Achievement(true, soulbound, 0);
        _setURI(id, metadataURI);
        emit AchievementDefined(id, key, soulbound);
    }

    /**
     * @notice Mints achievement `id` to `player`, once per player for the life of the contract.
     * @dev Reverts with AlreadyEarned on a repeat, including after a tradeable copy was sold
     *      on, so a backend retry cannot mint twice. A contract `player` must implement
     *      IERC1155Receiver, or the mint reverts.
     */
    function award(address player, uint256 id) external onlyRole(MINTER_ROLE) {
        Achievement storage achievement = achievements[id];
        if (!achievement.defined) revert UnknownAchievement(id);
        if (earned[player][id]) revert AlreadyEarned(player, id);

        earned[player][id] = true;
        ++achievement.awarded;
        _mint(player, id, 1, "");
    }

    /// @notice Replaces the `{id}` template, used by every achievement without its own URI.
    function setURI(string calldata newUri) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setURI(newUri);
    }

    /**
     * @notice Replaces one achievement's metadata URI, or clears it back to the template.
     * @dev Works after the first award too, so a dead link or a move to IPFS can be fixed. That
     *      means the admin can change what a held achievement looks like, the same reach
     *      `setURI` already gives over every achievement using the template, rarity included.
     *      The transfer rule stays out of reach.
     */
    function setAchievementURI(
        uint256 id,
        string calldata metadataURI
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!achievements[id].defined) revert UnknownAchievement(id);
        _setURI(id, metadataURI);
    }

    /// @dev Blocks holder-to-holder moves of soulbound ids, single or batched. Mints pass.
    function _update(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory values
    ) internal override {
        if (from != address(0) && to != address(0)) {
            for (uint256 i = 0; i < ids.length; ++i) {
                if (achievements[ids[i]].soulbound) revert Soulbound(ids[i]);
            }
        }
        super._update(from, to, ids, values);
    }

    /// @dev Resolves `supportsInterface`, declared by both ERC1155 and AccessControl.
    function supportsInterface(
        bytes4 interfaceId
    ) public view override(ERC1155, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
