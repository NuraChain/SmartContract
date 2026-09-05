// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title ProfileKeys
 * @notice The well-known keys the profile system gives meaning to. Everything here is a
 *         convention over the generic storage, not a schema: the core stores any key that
 *         passes validation, and these are simply the ones the typed getters, the
 *         `ProfileView` projection and the Nura applications agree on.
 *
 * Keys are `bytes32` short strings — the ASCII bytes left-aligned and zero-padded — so
 * they are readable in events, storage and block explorers without a lookup table. The
 * string form is what the external ABI takes; `ProfileStrings.toKey` does the conversion.
 *
 * Naming convention: lowerCamelCase for standard keys. Applications adding their own keys
 * should namespace them reverse-DNS style to avoid collisions, e.g. `social.nura.badges`
 * (still at most 32 bytes).
 */
library ProfileKeys {
    // ── standard profile fields (all localizable, stored under the default language "") ──

    bytes32 internal constant DISPLAY_NAME = "displayName";
    bytes32 internal constant BIO = "bio";
    bytes32 internal constant AVATAR = "avatar";
    bytes32 internal constant COVER = "cover";
    bytes32 internal constant LOCATION = "location";
    bytes32 internal constant JOB_TITLE = "jobTitle";
    bytes32 internal constant COMPANY = "company";

    // ── item kinds ───────────────────────────────────────────────────────────────────────

    bytes32 internal constant KIND_WEBSITE = "website";
    bytes32 internal constant KIND_IMAGE = "image";
    bytes32 internal constant KIND_SOCIAL = "social";

    // ── item attributes ──────────────────────────────────────────────────────────────────

    /// @dev website: the address itself. Not localized.
    bytes32 internal constant URL = "url";
    /// @dev website: display title. Localizable.
    bytes32 internal constant TITLE = "title";
    /// @dev website: optional longer text. Localizable.
    bytes32 internal constant DESCRIPTION = "description";
    /// @dev image: ipfs://, ar:// or https:// reference. Not localized.
    bytes32 internal constant URI = "uri";
    /// @dev image: free-form category such as avatar, cover, gallery, banner, portfolio.
    bytes32 internal constant CATEGORY = "category";
    /// @dev image: alternative text. Localizable.
    bytes32 internal constant ALT = "alt";
    /// @dev social: platform identifier such as twitter, github, telegram, farcaster, lens.
    bytes32 internal constant PLATFORM = "platform";
    /// @dev social: the account name on that platform.
    bytes32 internal constant HANDLE = "handle";
}
