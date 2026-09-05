// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title ProfileTypes
 * @notice Shared structs for the Nura profile system. Kept in one file so the core, the
 *         interface, extensions, and every off-chain consumer agree on a single ABI shape.
 *
 * Every localizable value is addressed by a (key, language) pair. An empty language string
 * means the default, unlocalized value; anything else is a lower-cased BCP-47 style tag
 * such as "en", "fa", "de", "zh-hant" or "pt-br".
 */

/**
 * @notice One (key, language, value) write. Used for batch field updates and for the
 *         attribute list handed to `addItem` / `setItemAttributes`.
 * @dev `lang` empty = default value. An empty `value` removes the entry.
 */
struct FieldInput {
    string key;
    string lang;
    string value;
}

/**
 * @notice The core's own record of a profile: ownership and bookkeeping, no content.
 *         Content is read through `resolveFields` / `resolveItemAttributes` (core) or the
 *         lens projections below.
 */
struct ProfileRecordView {
    address owner;
    string username;
    uint64 createdAt;
    uint64 updatedAt;
    address pendingOwner;
    address recovery;
    uint256 itemsCreated;
}

/**
 * @notice Snapshot of a profile's standard fields, resolved in one language with fallback
 *         to the default value. `id == 0` means the address has no profile. Served by
 *         {NuraProfileLens}.
 * @dev The standard fields are ordinary generic fields stored under the well-known keys in
 *      `ProfileKeys`; this struct is only a convenient projection of them.
 */
struct ProfileView {
    uint256 id;
    address owner;
    string username;
    uint64 createdAt;
    uint64 updatedAt;
    string displayName;
    string bio;
    string avatar;
    string cover;
    string location;
    string jobTitle;
    string company;
}

/// @notice Projection of an item of kind `website` (attributes `url`, `title`, `description`).
struct Website {
    uint256 id;
    string url;
    string title;
    string description;
}

/// @notice Projection of an item of kind `image` (attributes `uri`, `category`, `alt`).
struct Image {
    uint256 id;
    string uri;
    string category;
    string alt;
}

/// @notice Projection of an item of kind `social` (attributes `platform`, `handle`, `url`).
struct Social {
    uint256 id;
    string platform;
    string handle;
    string url;
}

/**
 * @notice Generic projection of an item: the attribute values requested by the caller, in the
 *         order the attribute keys were passed, each resolved with language fallback.
 */
struct ItemView {
    uint256 id;
    /// @dev Named `attributes`, not `values`: a field called `values` collides with Array.prototype.values on ethers Result objects.
    string[] attributes;
}

/// @notice Everything a wallet needs to render a profile card, in one call.
struct FullProfileView {
    ProfileView profile;
    Website[] websites;
    Image[] images;
    Social[] socials;
}
