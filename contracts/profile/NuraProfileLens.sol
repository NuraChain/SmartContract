// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {INuraProfile} from "./interfaces/INuraProfile.sol";
import {ProfileRecordView, ProfileView, FullProfileView, Website, Image, Social, ItemView} from "./ProfileTypes.sol";

/**
 * @title NuraProfileLens
 * @notice The read model for wallets and dapps: turns the core's primitive getters into the
 *         structs a UI renders — `getProfile(address)`, `getFullProfile`, `getWebsites`,
 *         `getImages`, `getSocials`, and a paged, attribute-projecting `getItems` for any
 *         kind an application invents.
 *
 * It is stateless and holds no authority: every value comes from `NuraProfile` through its
 * public view functions, so anyone can verify a lens result against the core, deploy their
 * own lens, or replace this one when a new item kind needs a typed projection — none of
 * which touches the upgradeable core or its storage. Keeping the projections here also keeps
 * the core well under Nurachain's 24 576-byte code limit with room for future versions.
 *
 * @dev Meant for `eth_call`. Every function is a view that fans out into several calls on
 *      the core; gas is only a concern if another contract reads through it on-chain, in
 *      which case the core's `resolveFields` / `resolveItemAttributes` are the cheaper path.
 */
contract NuraProfileLens {
    /// @notice The NuraProfile proxy this lens reads from.
    INuraProfile public immutable core;

    error ZeroAddress();

    constructor(address core_) {
        if (core_ == address(0)) revert ZeroAddress();
        core = INuraProfile(core_);
    }

    // ────────────────────────────────────────────────────────────────────────────────────────
    // Profiles
    // ────────────────────────────────────────────────────────────────────────────────────────

    /**
     * @notice Standard fields of the profile owned by `owner`, in `lang` with default
     *         fallback. Returns an empty view (`id == 0`) when the address has no profile.
     */
    function getProfile(address owner, string calldata lang) external view returns (ProfileView memory v) {
        uint256 profileId = core.profileIdOf(owner);
        if (profileId == 0) return v;
        return _profile(profileId, lang);
    }

    /// @notice Same as {getProfile}, by id. Reverts with ProfileNotFound for a dead id.
    function getProfileById(uint256 profileId, string calldata lang) external view returns (ProfileView memory) {
        return _profile(profileId, lang);
    }

    /// @notice Resolves a username (any casing) straight to its profile view; empty (`id == 0`) if unregistered.
    function getProfileByUsername(string calldata username, string calldata lang)
        external
        view
        returns (ProfileView memory v)
    {
        (uint256 profileId,) = core.resolveUsername(username);
        if (profileId == 0) return v;
        return _profile(profileId, lang);
    }

    /// @notice Standard fields plus websites, images and socials, in one call.
    function getFullProfile(address owner, string calldata lang) external view returns (FullProfileView memory full) {
        uint256 profileId = core.profileIdOf(owner);
        if (profileId == 0) return full;
        full.profile = _profile(profileId, lang);
        full.websites = _websites(profileId, lang);
        full.images = _images(profileId, lang);
        full.socials = _socials(profileId, lang);
    }

    /// @notice Same as {getFullProfile}, by id.
    function getFullProfileById(uint256 profileId, string calldata lang)
        external
        view
        returns (FullProfileView memory full)
    {
        full.profile = _profile(profileId, lang);
        full.websites = _websites(profileId, lang);
        full.images = _images(profileId, lang);
        full.socials = _socials(profileId, lang);
    }

    // ────────────────────────────────────────────────────────────────────────────────────────
    // Typed collections
    // ────────────────────────────────────────────────────────────────────────────────────────

    function getWebsites(uint256 profileId, string calldata lang) external view returns (Website[] memory) {
        return _websites(profileId, lang);
    }

    function getWebsite(uint256 profileId, uint256 websiteId, string calldata lang)
        external
        view
        returns (Website memory)
    {
        return _website(profileId, websiteId, lang);
    }

    function getImages(uint256 profileId, string calldata lang) external view returns (Image[] memory) {
        return _images(profileId, lang);
    }

    function getImage(uint256 profileId, uint256 imageId, string calldata lang) external view returns (Image memory) {
        return _image(profileId, imageId, lang);
    }

    function getSocials(uint256 profileId, string calldata lang) external view returns (Social[] memory) {
        return _socials(profileId, lang);
    }

    function getSocial(uint256 profileId, uint256 socialId, string calldata lang)
        external
        view
        returns (Social memory)
    {
        return _social(profileId, socialId, lang);
    }

    // ────────────────────────────────────────────────────────────────────────────────────────
    // Generic collections
    // ────────────────────────────────────────────────────────────────────────────────────────

    /**
     * @notice Pages through the profile's items of `kind`, projecting `attributeKeys` in
     *         `lang` with default fallback. `limit` 0 means "to the end". Works for every
     *         kind, including ones this lens has no typed getter for.
     * @return items The page, in list order.
     * @return total Total items of that kind on the profile.
     */
    function getItems(
        uint256 profileId,
        string calldata kind,
        string calldata lang,
        string[] calldata attributeKeys,
        uint256 offset,
        uint256 limit
    ) external view returns (ItemView[] memory items, uint256 total) {
        uint256[] memory ids = core.getItemIds(profileId, kind);
        total = ids.length;
        if (offset >= total) return (items, total);

        uint256 end = limit == 0 ? total : offset + limit;
        if (end > total) end = total;
        items = _page(profileId, ids, lang, attributeKeys, offset, end);
    }

    /// @dev Projects `ids[offset..end)` onto `attributeKeys`.
    function _page(
        uint256 profileId,
        uint256[] memory ids,
        string calldata lang,
        string[] calldata attributeKeys,
        uint256 offset,
        uint256 end
    ) private view returns (ItemView[] memory items) {
        items = new ItemView[](end - offset);
        for (uint256 i = offset; i < end; ) {
            uint256 itemId = ids[i];
            items[i - offset] = ItemView({id: itemId, attributes: core.resolveItemAttributes(profileId, itemId, attributeKeys, lang)});
            unchecked {
                ++i;
            }
        }
    }

    // ────────────────────────────────────────────────────────────────────────────────────────
    // Internal
    // ────────────────────────────────────────────────────────────────────────────────────────

    function _profile(uint256 profileId, string calldata lang) private view returns (ProfileView memory v) {
        ProfileRecordView memory r = core.getProfileRecord(profileId);
        string[] memory keys = new string[](7);
        keys[0] = "displayName";
        keys[1] = "bio";
        keys[2] = "avatar";
        keys[3] = "cover";
        keys[4] = "location";
        keys[5] = "jobTitle";
        keys[6] = "company";
        string[] memory f = core.resolveFields(profileId, keys, lang);

        v.id = profileId;
        v.owner = r.owner;
        v.username = r.username;
        v.createdAt = r.createdAt;
        v.updatedAt = r.updatedAt;
        v.displayName = f[0];
        v.bio = f[1];
        v.avatar = f[2];
        v.cover = f[3];
        v.location = f[4];
        v.jobTitle = f[5];
        v.company = f[6];
    }

    function _websites(uint256 profileId, string calldata lang) private view returns (Website[] memory list) {
        uint256[] memory ids = core.getItemIds(profileId, "website");
        list = new Website[](ids.length);
        for (uint256 i = 0; i < ids.length; ) {
            list[i] = _website(profileId, ids[i], lang);
            unchecked {
                ++i;
            }
        }
    }

    function _website(uint256 profileId, uint256 itemId, string calldata lang) private view returns (Website memory w) {
        string[] memory keys = new string[](3);
        keys[0] = "url";
        keys[1] = "title";
        keys[2] = "description";
        string[] memory a = core.resolveItemAttributes(profileId, itemId, keys, lang);
        w = Website({id: itemId, url: a[0], title: a[1], description: a[2]});
    }

    function _images(uint256 profileId, string calldata lang) private view returns (Image[] memory list) {
        uint256[] memory ids = core.getItemIds(profileId, "image");
        list = new Image[](ids.length);
        for (uint256 i = 0; i < ids.length; ) {
            list[i] = _image(profileId, ids[i], lang);
            unchecked {
                ++i;
            }
        }
    }

    function _image(uint256 profileId, uint256 itemId, string calldata lang) private view returns (Image memory im) {
        string[] memory keys = new string[](3);
        keys[0] = "uri";
        keys[1] = "category";
        keys[2] = "alt";
        string[] memory a = core.resolveItemAttributes(profileId, itemId, keys, lang);
        im = Image({id: itemId, uri: a[0], category: a[1], alt: a[2]});
    }

    function _socials(uint256 profileId, string calldata lang) private view returns (Social[] memory list) {
        uint256[] memory ids = core.getItemIds(profileId, "social");
        list = new Social[](ids.length);
        for (uint256 i = 0; i < ids.length; ) {
            list[i] = _social(profileId, ids[i], lang);
            unchecked {
                ++i;
            }
        }
    }

    function _social(uint256 profileId, uint256 itemId, string calldata lang) private view returns (Social memory s) {
        string[] memory keys = new string[](3);
        keys[0] = "platform";
        keys[1] = "handle";
        keys[2] = "url";
        string[] memory a = core.resolveItemAttributes(profileId, itemId, keys, lang);
        s = Social({id: itemId, platform: a[0], handle: a[1], url: a[2]});
    }
}
