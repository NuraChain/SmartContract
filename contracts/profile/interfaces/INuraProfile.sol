// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FieldInput, ProfileRecordView} from "../ProfileTypes.sol";

/**
 * @title INuraProfile
 * @notice External surface of the Nura profile registry: one profile per address, a global
 *         username namespace, generic localizable fields, generic item collections with
 *         typed sugar for websites / images / socials, and a curated extension registry.
 *
 * Identifiers: every write names the profile by `profileId` (what `profileIdOf(address)`
 * returns), so approved operators and smart accounts can act on a profile without being
 * its address. The core exposes primitive, batchable reads; the struct-shaped projections a
 * wallet wants (`getProfile(address)`, `getWebsites`, paged `getItems`, ...) live in the
 * stateless {NuraProfileLens}, which is replaceable without touching this contract.
 *
 * Keys, kinds and language tags are passed as strings and validated into `bytes32` short
 * strings (see ProfileStrings). Events carry the packed form so an indexer can filter on
 * them and still read them without a lookup table. An empty language means "default";
 * an empty value means "remove".
 *
 * Custom errors are declared at file level in ProfileErrors.sol and appear in the
 * implementing contract's ABI.
 */
interface INuraProfile {
    // ── events: lifecycle ────────────────────────────────────────────────────────────────

    /// @notice A profile was created. `username` is zero when none was registered.
    event ProfileCreated(uint256 indexed profileId, address indexed owner, bytes32 indexed username);
    /// @notice Something on the profile changed. Emitted alongside every content mutation
    ///         so a watcher can invalidate a cache with one subscription.
    event ProfileUpdated(uint256 indexed profileId);
    /// @notice A profile was deleted; its id is retired and its username released.
    event ProfileDeleted(uint256 indexed profileId, address indexed owner, bytes32 indexed username);
    /// @notice The owner (or recovery address) offered the profile to `to`.
    event ProfileTransferInitiated(uint256 indexed profileId, address indexed from, address indexed to);
    /// @notice A pending transfer was cancelled.
    event ProfileTransferCancelled(uint256 indexed profileId);
    /// @notice The pending owner accepted; `to` now owns the profile.
    event ProfileTransferred(uint256 indexed profileId, address indexed from, address indexed to);
    /// @notice The recovery address changed (zero = none).
    event RecoveryAddressSet(uint256 indexed profileId, address indexed recovery);
    /// @notice `owner` approved or revoked `operator` for every profile `owner` holds.
    event OperatorSet(address indexed owner, address indexed operator, bool approved);

    // ── events: usernames ────────────────────────────────────────────────────────────────

    /// @notice The profile's username changed. Either side may be zero (none).
    event UsernameChanged(uint256 indexed profileId, bytes32 indexed previousUsername, bytes32 indexed username);
    /// @notice The admin reserved a username. `claimant` zero means blocked for everyone.
    event UsernameReserved(bytes32 indexed username, address indexed claimant);
    /// @notice The admin lifted a reservation.
    event UsernameUnreserved(bytes32 indexed username);

    // ── events: fields ───────────────────────────────────────────────────────────────────

    /// @notice A default-language field was set.
    event FieldUpdated(uint256 indexed profileId, bytes32 indexed key, string value);
    /// @notice A localized field was set.
    event LocalizedFieldUpdated(uint256 indexed profileId, bytes32 indexed key, bytes32 indexed lang, string value);
    /// @notice A field was removed. `lang` zero = the default value.
    event FieldRemoved(uint256 indexed profileId, bytes32 indexed key, bytes32 indexed lang);

    // ── events: items (generic; also emitted by the typed functions) ─────────────────────

    /// @notice An item of `kind` was created. Emitted by addItem and every typed add.
    event ItemAdded(uint256 indexed profileId, uint256 indexed itemId, bytes32 indexed kind);
    /// @notice An item was removed. Emitted by removeItem and every typed remove.
    event ItemRemoved(uint256 indexed profileId, uint256 indexed itemId, bytes32 indexed kind);
    /// @notice An item attribute was set through the generic path.
    event ItemAttributeUpdated(
        uint256 indexed profileId, uint256 indexed itemId, bytes32 indexed key, bytes32 lang, string value
    );
    /// @notice An item attribute was removed through the generic path.
    event ItemAttributeRemoved(uint256 indexed profileId, uint256 indexed itemId, bytes32 indexed key, bytes32 lang);

    // ── events: typed items (carry the default-language attributes they set) ─────────────

    event WebsiteAdded(uint256 indexed profileId, uint256 indexed websiteId, string url, string title);
    event WebsiteUpdated(uint256 indexed profileId, uint256 indexed websiteId, string url, string title);
    event WebsiteRemoved(uint256 indexed profileId, uint256 indexed websiteId);

    event ImageAdded(uint256 indexed profileId, uint256 indexed imageId, string uri, string category, string alt);
    event ImageUpdated(uint256 indexed profileId, uint256 indexed imageId, string uri, string category, string alt);
    event ImageRemoved(uint256 indexed profileId, uint256 indexed imageId);

    event SocialAdded(uint256 indexed profileId, uint256 indexed socialId, string platform, string handle, string url);
    event SocialUpdated(uint256 indexed profileId, uint256 indexed socialId, string platform, string handle, string url);
    event SocialRemoved(uint256 indexed profileId, uint256 indexed socialId);

    // ── events: extensions ───────────────────────────────────────────────────────────────

    event ExtensionAdded(bytes32 indexed extensionId, address indexed extension);
    event ExtensionRemoved(bytes32 indexed extensionId, address indexed extension);
    /// @notice A profile owner allowed (or stopped allowing) an extension to write to them.
    event ExtensionApprovalSet(uint256 indexed profileId, bytes32 indexed extensionId, bool approved);
    /// @notice A registered, approved extension wrote into its namespace on a profile.
    event ExtensionFieldUpdated(
        uint256 indexed profileId, bytes32 indexed extensionId, bytes32 indexed key, bytes32 lang, string value
    );
    /// @notice An extension field was removed (by the extension, or by the profile owner).
    event ExtensionFieldRemoved(uint256 indexed profileId, bytes32 indexed extensionId, bytes32 indexed key, bytes32 lang);

    // ── profiles ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Creates the caller's profile. Every argument but `username` may be empty;
     *         an empty `username` registers none (set one later with `setUsername`).
     * @return profileId The new profile's id (ids start at 1 and are never reused).
     */
    function createProfile(
        string calldata username,
        string calldata displayName,
        string calldata bio,
        string calldata avatar
    ) external returns (uint256 profileId);

    /// @notice Deletes the caller's profile: releases the username and retires the id. Owner only.
    function deleteProfile(uint256 profileId) external;

    /// @notice Offers the profile to `to`, who must accept. Owner or recovery address.
    function transferProfile(uint256 profileId, address to) external;

    /// @notice Accepts a pending transfer. Caller must be the pending owner and own no profile.
    function acceptProfile(uint256 profileId) external;

    /// @notice Cancels a pending transfer. Owner or recovery address.
    function cancelTransfer(uint256 profileId) external;

    /// @notice Sets the address allowed to initiate a transfer if the owner key is lost. Owner only.
    function setRecoveryAddress(uint256 profileId, address recovery) external;

    /// @notice Approves `operator` to edit content on every profile the caller owns.
    ///         Operators cannot transfer, delete, rename, or manage operators/extensions.
    function setOperator(address operator, bool approved) external;

    // ── usernames ────────────────────────────────────────────────────────────────────────

    /// @notice Sets or clears (empty string) the profile's globally unique username. Owner only.
    function setUsername(uint256 profileId, string calldata username) external;

    /// @notice Admin: reserves a username. `claimant` may register it; zero blocks everyone.
    function reserveUsername(string calldata username, address claimant) external;

    /// @notice Admin: lifts a reservation.
    function unreserveUsername(string calldata username) external;

    // ── fields ───────────────────────────────────────────────────────────────────────────

    /// @notice Sets the default-language value of `key`. Empty value removes it.
    function setField(uint256 profileId, string calldata key, string calldata value) external;

    /// @notice Sets the value of `key` in `lang`. Empty value removes it.
    function setLocalizedField(uint256 profileId, string calldata key, string calldata lang, string calldata value)
        external;

    /// @notice Batch of (key, lang, value) writes in one transaction.
    function setFields(uint256 profileId, FieldInput[] calldata fields) external;

    /// @notice Removes the value of `key` in `lang` (empty lang = default).
    function removeField(uint256 profileId, string calldata key, string calldata lang) external;

    // ── items: generic ───────────────────────────────────────────────────────────────────

    /// @notice Creates an item of `kind` with the given attributes. Returns its id.
    function addItem(uint256 profileId, string calldata kind, FieldInput[] calldata attributes)
        external
        returns (uint256 itemId);

    /// @notice Sets one attribute of an item. Empty value removes it.
    function setItemAttribute(
        uint256 profileId,
        uint256 itemId,
        string calldata key,
        string calldata lang,
        string calldata value
    ) external;

    /// @notice Sets several attributes of an item.
    function setItemAttributes(uint256 profileId, uint256 itemId, FieldInput[] calldata attributes) external;

    /// @notice Removes an item and its position in its kind's list. Its attributes become unreachable.
    function removeItem(uint256 profileId, uint256 itemId) external;

    // ── items: typed sugar ───────────────────────────────────────────────────────────────

    function addWebsite(uint256 profileId, string calldata url, string calldata title)
        external
        returns (uint256 websiteId);
    function updateWebsite(uint256 profileId, uint256 websiteId, string calldata url, string calldata title) external;
    function removeWebsite(uint256 profileId, uint256 websiteId) external;

    function addImage(uint256 profileId, string calldata uri, string calldata category, string calldata alt)
        external
        returns (uint256 imageId);
    function updateImage(
        uint256 profileId,
        uint256 imageId,
        string calldata uri,
        string calldata category,
        string calldata alt
    ) external;
    function removeImage(uint256 profileId, uint256 imageId) external;

    function addSocial(uint256 profileId, string calldata platform, string calldata handle, string calldata url)
        external
        returns (uint256 socialId);
    function updateSocial(
        uint256 profileId,
        uint256 socialId,
        string calldata platform,
        string calldata handle,
        string calldata url
    ) external;
    function removeSocial(uint256 profileId, uint256 socialId) external;

    // ── extensions ───────────────────────────────────────────────────────────────────────

    /// @notice Admin: registers an extension under `extensionId` after the IProfileExtension handshake.
    function registerExtension(string calldata extensionId, address extension) external;

    /// @notice Admin: removes an extension. Its existing fields stay readable but nothing new can be written.
    function unregisterExtension(string calldata extensionId) external;

    /// @notice Profile owner: lets (or stops letting) a registered extension write to this profile.
    function approveExtension(uint256 profileId, string calldata extensionId, bool approved) external;

    /// @notice Registered + approved extension: writes into its own namespace on the profile.
    function setExtensionField(uint256 profileId, string calldata key, string calldata lang, string calldata value)
        external;

    /// @notice Removes an extension field. Callable by that extension, or by the profile owner / operator.
    function removeExtensionField(
        uint256 profileId,
        string calldata extensionId,
        string calldata key,
        string calldata lang
    ) external;

    // ── views: profiles & ownership ──────────────────────────────────────────────────────

    function profileIdOf(address owner) external view returns (uint256);
    function ownerOf(uint256 profileId) external view returns (address);
    function exists(uint256 profileId) external view returns (bool);
    function pendingOwnerOf(uint256 profileId) external view returns (address);
    function recoveryAddressOf(uint256 profileId) external view returns (address);
    function isOperator(address owner, address operator) external view returns (bool);
    /// @notice True when `account` is the owner of `profileId` or an approved operator of that owner.
    function isAuthorized(uint256 profileId, address account) external view returns (bool);
    /// @notice Number of profile ids issued so far (deleted profiles included; ids are never reused).
    function profilesCreated() external view returns (uint256);

    /// @notice Ownership and bookkeeping of a profile. Reverts with ProfileNotFound for a dead id.
    function getProfileRecord(uint256 profileId) external view returns (ProfileRecordView memory);

    // ── views: usernames ─────────────────────────────────────────────────────────────────

    function usernameOf(uint256 profileId) external view returns (string memory);
    /// @notice Resolves a username (any casing) to its profile and owner; zeros when unregistered or invalid.
    function resolveUsername(string calldata username) external view returns (uint256 profileId, address owner);
    /// @notice True when the username is valid, unregistered and not reserved.
    function isUsernameAvailable(string calldata username) external view returns (bool);
    /// @notice The canonical (lower-cased) form of a username. Reverts if invalid.
    function normalizeUsername(string calldata username) external pure returns (string memory);
    function usernameReservation(string calldata username) external view returns (address claimant, bool active);

    // ── views: fields ────────────────────────────────────────────────────────────────────

    /// @notice Default-language value of `key`.
    function getField(uint256 profileId, string calldata key) external view returns (string memory);
    /// @notice Exact value of `key` in `lang` (no fallback).
    function getLocalizedField(uint256 profileId, string calldata key, string calldata lang)
        external
        view
        returns (string memory);
    /// @notice Value of `key` in `lang`, falling back to the default when unset.
    function resolveField(uint256 profileId, string calldata key, string calldata lang)
        external
        view
        returns (string memory);
    /// @notice Several keys at once, each in `lang` with default fallback. Same order as `keys`.
    function resolveFields(uint256 profileId, string[] calldata keys, string calldata lang)
        external
        view
        returns (string[] memory values);

    // ── views: items ─────────────────────────────────────────────────────────────────────

    function getItemIds(uint256 profileId, string calldata kind) external view returns (uint256[] memory);
    function getItemCount(uint256 profileId, string calldata kind) external view returns (uint256);
    /// @notice Kind of an item as a string; empty when the item does not exist.
    function getItemKind(uint256 profileId, uint256 itemId) external view returns (string memory);
    function getItemAttribute(uint256 profileId, uint256 itemId, string calldata key, string calldata lang)
        external
        view
        returns (string memory);
    function resolveItemAttribute(uint256 profileId, uint256 itemId, string calldata key, string calldata lang)
        external
        view
        returns (string memory);
    /// @notice Several attributes of one item, each in `lang` with default fallback. Same order as `keys`.
    function resolveItemAttributes(uint256 profileId, uint256 itemId, string[] calldata keys, string calldata lang)
        external
        view
        returns (string[] memory values);

    // ── views: extensions ────────────────────────────────────────────────────────────────

    function getExtension(string calldata extensionId) external view returns (address);
    function extensionIdOf(address extension) external view returns (bytes32);
    function getExtensions() external view returns (bytes32[] memory ids, address[] memory extensions);
    function isExtensionApproved(uint256 profileId, string calldata extensionId) external view returns (bool);
    function getExtensionField(
        uint256 profileId,
        string calldata extensionId,
        string calldata key,
        string calldata lang
    ) external view returns (string memory);
}
