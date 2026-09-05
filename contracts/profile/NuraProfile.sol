// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {ERC165Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/introspection/ERC165Upgradeable.sol";
import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";

import {INuraProfile} from "./interfaces/INuraProfile.sol";
import {IProfileExtension} from "./interfaces/IProfileExtension.sol";
import {ProfileKeys} from "./libraries/ProfileKeys.sol";
import {ProfileStrings} from "./libraries/ProfileStrings.sol";
import {FieldInput, ProfileRecordView} from "./ProfileTypes.sol";
import {
    ProfileNotFound,
    AlreadyHasProfile,
    NotAuthorized,
    NotProfileOwner,
    NotOwnerOrRecovery,
    NotPendingOwner,
    NoPendingTransfer,
    ZeroAddress,
    InvalidAddress,
    UsernameTaken,
    UsernameIsReserved,
    UsernameUnchanged,
    ValueTooLong,
    ItemNotFound,
    ItemKindMismatch,
    ExtensionAlreadyRegistered,
    ExtensionNotRegistered,
    ExtensionNotApproved,
    InvalidExtension,
    ExtensionIdMismatch
} from "./ProfileErrors.sol";

/**
 * @title NuraProfile
 * @notice A decentralized, extensible profile primitive for the Nura ecosystem: one profile
 *         per address, a global username namespace, localizable key/value fields, generic
 *         item collections (websites, images, socials, and any kind an application invents),
 *         and a curated registry of extension contracts that may attest data into their own
 *         namespace on a profile.
 *
 * The schema is deliberately not a struct of fixed columns. Every value is addressed by
 * (profileId, key, language), so "add a field" is a frontend convention, not a redeploy;
 * every list item is a bag of localizable attributes under a free-form `kind`, so "add a
 * wallets section" is `addItem(id, "wallet", [...])`, not a new contract. The standard
 * fields (`displayName`, `bio`, `avatar`, ...) and kinds (`website`, `image`, `social`) are
 * well-known keys from {ProfileKeys} that the typed helpers project into structs for
 * wallets — sugar over the same storage.
 *
 * Authorization is strictly the owner's: only the owner (or an operator the owner approved)
 * edits content; only the owner renames, deletes, transfers, or approves extensions; the
 * contract admin can upgrade the implementation, curate the extension registry and reserve
 * usernames — and nothing else. There is no admin path that edits or removes a user's data.
 *
 * @dev UUPS upgradeable, storage in a single ERC-7201 namespace (append-only struct, no gaps
 *      to count). No external calls in user paths; the only outgoing calls are the ERC-165
 *      handshake when the admin registers an extension. Deleting a profile or removing an
 *      item retires the id rather than clearing its strings — ids are never reused, so the
 *      orphaned storage is unreachable through the API and clearing it would be an
 *      unbounded loop.
 */
contract NuraProfile is INuraProfile, Initializable, Ownable2StepUpgradeable, UUPSUpgradeable, ERC165Upgradeable {
    using ProfileStrings for string;
    using ProfileStrings for bytes32;

    /// @notice Implementation version, for post-upgrade sanity checks.
    string public constant VERSION = "1.0.0";
    /// @notice Longest value (in bytes) a single field or attribute may hold. Bigger content
    ///         belongs off-chain, referenced by URI — that is what this cap enforces.
    uint256 public constant MAX_VALUE_LENGTH = 4096;
    /// @notice Username bounds, after lower-casing. See ProfileStrings.toUsername for the alphabet.
    uint256 public constant MIN_USERNAME_LENGTH = ProfileStrings.MIN_USERNAME_LENGTH;
    uint256 public constant MAX_USERNAME_LENGTH = ProfileStrings.MAX_USERNAME_LENGTH;

    /// @dev Per-profile record. Slot 1 packs owner + timestamps so a content write touches a
    ///      slot the authorization check already warmed; slot 3 packs the rarely-set pending
    ///      owner with the item counter.
    struct ProfileRecord {
        address owner;
        uint40 createdAt;
        uint40 updatedAt;
        bytes32 username;
        address pendingOwner;
        uint32 nextItemId;
        address recovery;
    }

    /// @dev One slot: the kind (short string, <= 28 bytes) and the item's position in its kind's list.
    struct ItemRecord {
        bytes28 kind;
        uint32 index;
    }

    /// @dev One slot. `active` distinguishes "reserved for nobody" from "not reserved".
    struct Reservation {
        address claimant;
        bool active;
    }

    /// @custom:storage-location erc7201:nura.storage.NuraProfile
    struct Layout {
        uint256 nextProfileId;
        mapping(uint256 profileId => ProfileRecord) profiles;
        mapping(address owner => uint256 profileId) profileIdOf;
        mapping(bytes32 username => uint256 profileId) usernameToProfile;
        mapping(bytes32 username => Reservation) reservations;
        mapping(address owner => mapping(address operator => bool approved)) operators;
        mapping(uint256 profileId => mapping(bytes32 key => mapping(bytes32 lang => string value))) fields;
        mapping(uint256 profileId => mapping(uint256 itemId => ItemRecord)) items;
        mapping(uint256 profileId => mapping(bytes32 kind => uint32[] ids)) itemIds;
        mapping(uint256 profileId => mapping(uint256 itemId => mapping(bytes32 key => mapping(bytes32 lang => string value))))
            itemAttributes;
        mapping(bytes32 extensionId => address extension) extensions;
        mapping(address extension => bytes32 extensionId) extensionIdOf;
        bytes32[] extensionIds;
        mapping(bytes32 extensionId => uint256 indexPlusOne) extensionIndex;
        mapping(uint256 profileId => mapping(bytes32 extensionId => bool approved)) extensionApprovals;
        mapping(uint256 profileId => mapping(bytes32 extensionId => mapping(bytes32 key => mapping(bytes32 lang => string value))))
            extensionFields;
    }

    // keccak256(abi.encode(uint256(keccak256("nura.storage.NuraProfile")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant LAYOUT_SLOT = 0x2fd3cb398506b389565dadff107316c87c7c92d40494549e70e4bd092e543300;

    function _layout() private pure returns (Layout storage $) {
        assembly ("memory-safe") {
            $.slot := LAYOUT_SLOT
        }
    }

    // ────────────────────────────────────────────────────────────────────────────────────────
    // Setup
    // ────────────────────────────────────────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @param initialOwner Contract admin: upgrades, extension registry, username reservations.
    function initialize(address initialOwner) external initializer {
        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        __ERC165_init();
    }

    /// @dev UUPS: only the admin may upgrade. Two-step ownership means a mistyped transfer cannot brick this.
    function _authorizeUpgrade(address) internal override onlyOwner {}

    /// @inheritdoc ERC165Upgradeable
    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == type(INuraProfile).interfaceId || super.supportsInterface(interfaceId);
    }

    // ────────────────────────────────────────────────────────────────────────────────────────
    // Profiles
    // ────────────────────────────────────────────────────────────────────────────────────────

    /// @inheritdoc INuraProfile
    function createProfile(
        string calldata username,
        string calldata displayName,
        string calldata bio,
        string calldata avatar
    ) external returns (uint256 profileId) {
        Layout storage $ = _layout();
        if ($.profileIdOf[msg.sender] != 0) revert AlreadyHasProfile(msg.sender);

        profileId = ++$.nextProfileId;
        ProfileRecord storage p = $.profiles[profileId];
        p.owner = msg.sender;
        p.createdAt = uint40(block.timestamp);
        p.updatedAt = uint40(block.timestamp);
        $.profileIdOf[msg.sender] = profileId;

        bytes32 name;
        if (bytes(username).length != 0) {
            name = username.toUsername();
            _claimUsername($, profileId, msg.sender, name);
            p.username = name;
        }
        emit ProfileCreated(profileId, msg.sender, name);

        if (bytes(displayName).length != 0) _setField($, profileId, ProfileKeys.DISPLAY_NAME, 0, displayName);
        if (bytes(bio).length != 0) _setField($, profileId, ProfileKeys.BIO, 0, bio);
        if (bytes(avatar).length != 0) _setField($, profileId, ProfileKeys.AVATAR, 0, avatar);
    }

    /// @inheritdoc INuraProfile
    function deleteProfile(uint256 profileId) external {
        Layout storage $ = _layout();
        ProfileRecord storage p = _requireOwner($, profileId);

        bytes32 username = p.username;
        if (username != 0) delete $.usernameToProfile[username];
        delete $.profileIdOf[msg.sender];
        delete $.profiles[profileId];

        emit ProfileDeleted(profileId, msg.sender, username);
    }

    /// @inheritdoc INuraProfile
    function transferProfile(uint256 profileId, address to) external {
        Layout storage $ = _layout();
        ProfileRecord storage p = _requireOwnerOrRecovery($, profileId);
        if (to == address(0)) revert ZeroAddress();
        if (to == p.owner) revert InvalidAddress(to);
        if ($.profileIdOf[to] != 0) revert AlreadyHasProfile(to);

        p.pendingOwner = to;
        emit ProfileTransferInitiated(profileId, p.owner, to);
    }

    /// @inheritdoc INuraProfile
    function acceptProfile(uint256 profileId) external {
        Layout storage $ = _layout();
        ProfileRecord storage p = _requireProfile($, profileId);
        if (p.pendingOwner != msg.sender) revert NotPendingOwner(profileId, msg.sender);
        if ($.profileIdOf[msg.sender] != 0) revert AlreadyHasProfile(msg.sender);

        address from = p.owner;
        delete $.profileIdOf[from];
        $.profileIdOf[msg.sender] = profileId;
        p.owner = msg.sender;
        p.pendingOwner = address(0);
        // The recovery address was the previous owner's choice; the new owner sets their own.
        p.recovery = address(0);

        _touch(p, profileId);
        emit ProfileTransferred(profileId, from, msg.sender);
    }

    /// @inheritdoc INuraProfile
    function cancelTransfer(uint256 profileId) external {
        ProfileRecord storage p = _requireOwnerOrRecovery(_layout(), profileId);
        if (p.pendingOwner == address(0)) revert NoPendingTransfer(profileId);

        p.pendingOwner = address(0);
        emit ProfileTransferCancelled(profileId);
    }

    /// @inheritdoc INuraProfile
    function setRecoveryAddress(uint256 profileId, address recovery) external {
        ProfileRecord storage p = _requireOwner(_layout(), profileId);
        if (recovery == msg.sender) revert InvalidAddress(recovery);

        p.recovery = recovery;
        emit RecoveryAddressSet(profileId, recovery);
    }

    /// @inheritdoc INuraProfile
    function setOperator(address operator, bool approved) external {
        if (operator == address(0)) revert ZeroAddress();
        if (operator == msg.sender) revert InvalidAddress(operator);

        _layout().operators[msg.sender][operator] = approved;
        emit OperatorSet(msg.sender, operator, approved);
    }

    // ────────────────────────────────────────────────────────────────────────────────────────
    // Usernames
    // ────────────────────────────────────────────────────────────────────────────────────────

    /// @inheritdoc INuraProfile
    function setUsername(uint256 profileId, string calldata username) external {
        Layout storage $ = _layout();
        ProfileRecord storage p = _requireOwner($, profileId);

        bytes32 previous = p.username;
        bytes32 next;
        if (bytes(username).length != 0) next = username.toUsername();
        if (next == previous) revert UsernameUnchanged(next);

        if (next != 0) _claimUsername($, profileId, msg.sender, next);
        if (previous != 0) delete $.usernameToProfile[previous];
        p.username = next;

        _touch(p, profileId);
        emit UsernameChanged(profileId, previous, next);
    }

    /// @inheritdoc INuraProfile
    function reserveUsername(string calldata username, address claimant) external onlyOwner {
        bytes32 key = username.toUsername();
        _layout().reservations[key] = Reservation({claimant: claimant, active: true});
        emit UsernameReserved(key, claimant);
    }

    /// @inheritdoc INuraProfile
    function unreserveUsername(string calldata username) external onlyOwner {
        bytes32 key = username.toUsername();
        delete _layout().reservations[key];
        emit UsernameUnreserved(key);
    }

    /// @dev Registers `key` for `profileId`, honouring reservations. Consumes a reservation
    ///      held by `claimant` once it is used.
    function _claimUsername(Layout storage $, uint256 profileId, address claimant, bytes32 key) private {
        if ($.usernameToProfile[key] != 0) revert UsernameTaken(key);

        Reservation storage r = $.reservations[key];
        if (r.active) {
            if (r.claimant != claimant) revert UsernameIsReserved(key);
            delete $.reservations[key];
        }
        $.usernameToProfile[key] = profileId;
    }

    // ────────────────────────────────────────────────────────────────────────────────────────
    // Fields
    // ────────────────────────────────────────────────────────────────────────────────────────

    /// @inheritdoc INuraProfile
    function setField(uint256 profileId, string calldata key, string calldata value) external {
        Layout storage $ = _layout();
        ProfileRecord storage p = _requireAuthorized($, profileId);
        _setField($, profileId, key.toKey(), 0, value);
        _touch(p, profileId);
    }

    /// @inheritdoc INuraProfile
    function setLocalizedField(uint256 profileId, string calldata key, string calldata lang, string calldata value)
        external
    {
        Layout storage $ = _layout();
        ProfileRecord storage p = _requireAuthorized($, profileId);
        _setField($, profileId, key.toKey(), lang.toLang(), value);
        _touch(p, profileId);
    }

    /// @inheritdoc INuraProfile
    function setFields(uint256 profileId, FieldInput[] calldata fields) external {
        Layout storage $ = _layout();
        ProfileRecord storage p = _requireAuthorized($, profileId);
        uint256 n = fields.length;
        for (uint256 i = 0; i < n; ) {
            _setField($, profileId, fields[i].key.toKey(), fields[i].lang.toLang(), fields[i].value);
            unchecked {
                ++i;
            }
        }
        _touch(p, profileId);
    }

    /// @inheritdoc INuraProfile
    function removeField(uint256 profileId, string calldata key, string calldata lang) external {
        Layout storage $ = _layout();
        ProfileRecord storage p = _requireAuthorized($, profileId);
        bytes32 k = key.toKey();
        bytes32 l = lang.toLang();
        delete $.fields[profileId][k][l];
        emit FieldRemoved(profileId, k, l);
        _touch(p, profileId);
    }

    /// @dev Writes or (for an empty value) removes a field and emits the matching event.
    function _setField(Layout storage $, uint256 profileId, bytes32 key, bytes32 lang, string calldata value)
        private
    {
        if (_store($.fields[profileId][key], lang, value)) {
            if (lang == 0) emit FieldUpdated(profileId, key, value);
            else emit LocalizedFieldUpdated(profileId, key, lang, value);
        } else {
            emit FieldRemoved(profileId, key, lang);
        }
    }

    // ────────────────────────────────────────────────────────────────────────────────────────
    // Items: generic
    // ────────────────────────────────────────────────────────────────────────────────────────

    /// @inheritdoc INuraProfile
    function addItem(uint256 profileId, string calldata kind, FieldInput[] calldata attributes)
        external
        returns (uint256 itemId)
    {
        Layout storage $ = _layout();
        ProfileRecord storage p = _requireAuthorized($, profileId);
        itemId = _addItem($, p, profileId, kind.toKind());

        uint256 n = attributes.length;
        for (uint256 i = 0; i < n; ) {
            _setItemAttribute(
                $, profileId, itemId, attributes[i].key.toKey(), attributes[i].lang.toLang(), attributes[i].value
            );
            unchecked {
                ++i;
            }
        }
        _touch(p, profileId);
    }

    /// @inheritdoc INuraProfile
    function setItemAttribute(
        uint256 profileId,
        uint256 itemId,
        string calldata key,
        string calldata lang,
        string calldata value
    ) external {
        Layout storage $ = _layout();
        ProfileRecord storage p = _requireAuthorized($, profileId);
        _requireItem($, profileId, itemId);
        _setItemAttribute($, profileId, itemId, key.toKey(), lang.toLang(), value);
        _touch(p, profileId);
    }

    /// @inheritdoc INuraProfile
    function setItemAttributes(uint256 profileId, uint256 itemId, FieldInput[] calldata attributes) external {
        Layout storage $ = _layout();
        ProfileRecord storage p = _requireAuthorized($, profileId);
        _requireItem($, profileId, itemId);

        uint256 n = attributes.length;
        for (uint256 i = 0; i < n; ) {
            _setItemAttribute(
                $, profileId, itemId, attributes[i].key.toKey(), attributes[i].lang.toLang(), attributes[i].value
            );
            unchecked {
                ++i;
            }
        }
        _touch(p, profileId);
    }

    /// @inheritdoc INuraProfile
    function removeItem(uint256 profileId, uint256 itemId) external {
        Layout storage $ = _layout();
        ProfileRecord storage p = _requireAuthorized($, profileId);
        _removeItem($, profileId, itemId);
        _touch(p, profileId);
    }

    /// @dev Allocates the next item id on the profile and appends it to its kind's list.
    function _addItem(Layout storage $, ProfileRecord storage p, uint256 profileId, bytes32 kind)
        private
        returns (uint256 itemId)
    {
        itemId = ++p.nextItemId;
        uint32[] storage ids = $.itemIds[profileId][kind];
        $.items[profileId][itemId] = ItemRecord({kind: bytes28(kind), index: uint32(ids.length)});
        ids.push(uint32(itemId));
        emit ItemAdded(profileId, itemId, kind);
    }

    /// @dev Swap-and-pop removal from the kind list. Attributes are left orphaned: the id is
    ///      never reused, so they are unreachable, and clearing them would be unbounded.
    function _removeItem(Layout storage $, uint256 profileId, uint256 itemId) private returns (bytes32 kind) {
        ItemRecord memory rec = $.items[profileId][itemId];
        if (rec.kind == 0) revert ItemNotFound(itemId);
        kind = bytes32(rec.kind);

        uint32[] storage ids = $.itemIds[profileId][kind];
        uint256 last = ids.length - 1;
        if (rec.index != last) {
            uint32 moved = ids[last];
            ids[rec.index] = moved;
            $.items[profileId][moved].index = rec.index;
        }
        ids.pop();
        delete $.items[profileId][itemId];

        emit ItemRemoved(profileId, itemId, kind);
    }

    /// @dev Generic attribute write with its generic event.
    function _setItemAttribute(
        Layout storage $,
        uint256 profileId,
        uint256 itemId,
        bytes32 key,
        bytes32 lang,
        string calldata value
    ) private {
        if (_store($.itemAttributes[profileId][itemId][key], lang, value)) {
            emit ItemAttributeUpdated(profileId, itemId, key, lang, value);
        } else {
            emit ItemAttributeRemoved(profileId, itemId, key, lang);
        }
    }

    /// @dev Attribute write for the typed helpers, which emit their own event instead.
    function _storeItemAttribute(Layout storage $, uint256 profileId, uint256 itemId, bytes32 key, string calldata value)
        private
    {
        _store($.itemAttributes[profileId][itemId][key], 0, value);
    }

    // ────────────────────────────────────────────────────────────────────────────────────────
    // Items: websites / images / socials
    // ────────────────────────────────────────────────────────────────────────────────────────

    /// @inheritdoc INuraProfile
    function addWebsite(uint256 profileId, string calldata url, string calldata title)
        external
        returns (uint256 websiteId)
    {
        Layout storage $ = _layout();
        ProfileRecord storage p = _requireAuthorized($, profileId);
        websiteId = _addItem($, p, profileId, ProfileKeys.KIND_WEBSITE);
        _writeWebsite($, profileId, websiteId, url, title, true);
        _touch(p, profileId);
    }

    /// @inheritdoc INuraProfile
    function updateWebsite(uint256 profileId, uint256 websiteId, string calldata url, string calldata title) external {
        Layout storage $ = _layout();
        ProfileRecord storage p = _requireAuthorized($, profileId);
        _requireKind($, profileId, websiteId, ProfileKeys.KIND_WEBSITE);
        _writeWebsite($, profileId, websiteId, url, title, false);
        _touch(p, profileId);
    }

    /// @inheritdoc INuraProfile
    function removeWebsite(uint256 profileId, uint256 websiteId) external {
        Layout storage $ = _layout();
        ProfileRecord storage p = _requireAuthorized($, profileId);
        _requireKind($, profileId, websiteId, ProfileKeys.KIND_WEBSITE);
        _removeItem($, profileId, websiteId);
        emit WebsiteRemoved(profileId, websiteId);
        _touch(p, profileId);
    }

    /// @inheritdoc INuraProfile
    function addImage(uint256 profileId, string calldata uri, string calldata category, string calldata alt)
        external
        returns (uint256 imageId)
    {
        Layout storage $ = _layout();
        ProfileRecord storage p = _requireAuthorized($, profileId);
        imageId = _addItem($, p, profileId, ProfileKeys.KIND_IMAGE);
        _writeImage($, profileId, imageId, uri, category, alt, true);
        _touch(p, profileId);
    }

    /// @inheritdoc INuraProfile
    function updateImage(
        uint256 profileId,
        uint256 imageId,
        string calldata uri,
        string calldata category,
        string calldata alt
    ) external {
        Layout storage $ = _layout();
        ProfileRecord storage p = _requireAuthorized($, profileId);
        _requireKind($, profileId, imageId, ProfileKeys.KIND_IMAGE);
        _writeImage($, profileId, imageId, uri, category, alt, false);
        _touch(p, profileId);
    }

    /// @inheritdoc INuraProfile
    function removeImage(uint256 profileId, uint256 imageId) external {
        Layout storage $ = _layout();
        ProfileRecord storage p = _requireAuthorized($, profileId);
        _requireKind($, profileId, imageId, ProfileKeys.KIND_IMAGE);
        _removeItem($, profileId, imageId);
        emit ImageRemoved(profileId, imageId);
        _touch(p, profileId);
    }

    /// @inheritdoc INuraProfile
    function addSocial(uint256 profileId, string calldata platform, string calldata handle, string calldata url)
        external
        returns (uint256 socialId)
    {
        Layout storage $ = _layout();
        ProfileRecord storage p = _requireAuthorized($, profileId);
        socialId = _addItem($, p, profileId, ProfileKeys.KIND_SOCIAL);
        _writeSocial($, profileId, socialId, platform, handle, url, true);
        _touch(p, profileId);
    }

    /// @inheritdoc INuraProfile
    function updateSocial(
        uint256 profileId,
        uint256 socialId,
        string calldata platform,
        string calldata handle,
        string calldata url
    ) external {
        Layout storage $ = _layout();
        ProfileRecord storage p = _requireAuthorized($, profileId);
        _requireKind($, profileId, socialId, ProfileKeys.KIND_SOCIAL);
        _writeSocial($, profileId, socialId, platform, handle, url, false);
        _touch(p, profileId);
    }

    /// @inheritdoc INuraProfile
    function removeSocial(uint256 profileId, uint256 socialId) external {
        Layout storage $ = _layout();
        ProfileRecord storage p = _requireAuthorized($, profileId);
        _requireKind($, profileId, socialId, ProfileKeys.KIND_SOCIAL);
        _removeItem($, profileId, socialId);
        emit SocialRemoved(profileId, socialId);
        _touch(p, profileId);
    }

    /// @dev Shared body of addWebsite / updateWebsite: stores the default-language attributes and
    ///      emits the typed event that carries them (instead of one generic event per attribute).
    function _writeWebsite(
        Layout storage $,
        uint256 profileId,
        uint256 websiteId,
        string calldata url,
        string calldata title,
        bool isNew
    ) private {
        _storeItemAttribute($, profileId, websiteId, ProfileKeys.URL, url);
        _storeItemAttribute($, profileId, websiteId, ProfileKeys.TITLE, title);
        if (isNew) emit WebsiteAdded(profileId, websiteId, url, title);
        else emit WebsiteUpdated(profileId, websiteId, url, title);
    }

    function _writeImage(
        Layout storage $,
        uint256 profileId,
        uint256 imageId,
        string calldata uri,
        string calldata category,
        string calldata alt,
        bool isNew
    ) private {
        _storeItemAttribute($, profileId, imageId, ProfileKeys.URI, uri);
        _storeItemAttribute($, profileId, imageId, ProfileKeys.CATEGORY, category);
        _storeItemAttribute($, profileId, imageId, ProfileKeys.ALT, alt);
        if (isNew) emit ImageAdded(profileId, imageId, uri, category, alt);
        else emit ImageUpdated(profileId, imageId, uri, category, alt);
    }

    function _writeSocial(
        Layout storage $,
        uint256 profileId,
        uint256 socialId,
        string calldata platform,
        string calldata handle,
        string calldata url,
        bool isNew
    ) private {
        _storeItemAttribute($, profileId, socialId, ProfileKeys.PLATFORM, platform);
        _storeItemAttribute($, profileId, socialId, ProfileKeys.HANDLE, handle);
        _storeItemAttribute($, profileId, socialId, ProfileKeys.URL, url);
        if (isNew) emit SocialAdded(profileId, socialId, platform, handle, url);
        else emit SocialUpdated(profileId, socialId, platform, handle, url);
    }

    // ────────────────────────────────────────────────────────────────────────────────────────
    // Extensions
    // ────────────────────────────────────────────────────────────────────────────────────────

    /// @inheritdoc INuraProfile
    function registerExtension(string calldata extensionId, address extension) external onlyOwner {
        Layout storage $ = _layout();
        bytes32 id = extensionId.toKey();
        if (extension == address(0)) revert ZeroAddress();
        if ($.extensions[id] != address(0)) revert ExtensionAlreadyRegistered(id);
        if ($.extensionIdOf[extension] != 0) revert ExtensionAlreadyRegistered($.extensionIdOf[extension]);

        // Handshake: the contract must say it is an extension, agree on its id, and serve
        // this registry. Static calls only, and only here — never during user actions.
        if (!ERC165Checker.supportsInterface(extension, type(IProfileExtension).interfaceId)) {
            revert InvalidExtension(extension);
        }
        bytes32 reported = IProfileExtension(extension).extensionId();
        if (reported != id) revert ExtensionIdMismatch(id, reported);
        if (IProfileExtension(extension).profileRegistry() != address(this)) revert InvalidExtension(extension);

        $.extensions[id] = extension;
        $.extensionIdOf[extension] = id;
        $.extensionIds.push(id);
        $.extensionIndex[id] = $.extensionIds.length;
        emit ExtensionAdded(id, extension);
    }

    /// @inheritdoc INuraProfile
    function unregisterExtension(string calldata extensionId) external onlyOwner {
        Layout storage $ = _layout();
        bytes32 id = extensionId.toKey();
        address extension = $.extensions[id];
        if (extension == address(0)) revert ExtensionNotRegistered(id);

        uint256 index = $.extensionIndex[id] - 1;
        uint256 last = $.extensionIds.length - 1;
        if (index != last) {
            bytes32 moved = $.extensionIds[last];
            $.extensionIds[index] = moved;
            $.extensionIndex[moved] = index + 1;
        }
        $.extensionIds.pop();
        delete $.extensionIndex[id];
        delete $.extensions[id];
        delete $.extensionIdOf[extension];
        emit ExtensionRemoved(id, extension);
    }

    /// @inheritdoc INuraProfile
    function approveExtension(uint256 profileId, string calldata extensionId, bool approved) external {
        Layout storage $ = _layout();
        _requireOwner($, profileId);
        bytes32 id = extensionId.toKey();
        if ($.extensions[id] == address(0)) revert ExtensionNotRegistered(id);

        $.extensionApprovals[profileId][id] = approved;
        emit ExtensionApprovalSet(profileId, id, approved);
    }

    /// @inheritdoc INuraProfile
    function setExtensionField(uint256 profileId, string calldata key, string calldata lang, string calldata value)
        external
    {
        Layout storage $ = _layout();
        bytes32 id = $.extensionIdOf[msg.sender];
        if (id == 0) revert ExtensionNotRegistered(0);
        ProfileRecord storage p = _requireProfile($, profileId);
        if (!$.extensionApprovals[profileId][id]) revert ExtensionNotApproved(profileId, id);

        bytes32 k = key.toKey();
        bytes32 l = lang.toLang();
        if (_store($.extensionFields[profileId][id][k], l, value)) {
            emit ExtensionFieldUpdated(profileId, id, k, l, value);
        } else {
            emit ExtensionFieldRemoved(profileId, id, k, l);
        }
        _touch(p, profileId);
    }

    /// @inheritdoc INuraProfile
    function removeExtensionField(
        uint256 profileId,
        string calldata extensionId,
        string calldata key,
        string calldata lang
    ) external {
        Layout storage $ = _layout();
        bytes32 id = extensionId.toKey();
        ProfileRecord storage p = _requireProfile($, profileId);

        bool isTheExtension = $.extensionIdOf[msg.sender] == id;
        if (!isTheExtension && msg.sender != p.owner && !$.operators[p.owner][msg.sender]) {
            revert NotAuthorized(profileId, msg.sender);
        }

        bytes32 k = key.toKey();
        bytes32 l = lang.toLang();
        delete $.extensionFields[profileId][id][k][l];
        emit ExtensionFieldRemoved(profileId, id, k, l);
        _touch(p, profileId);
    }

    // ────────────────────────────────────────────────────────────────────────────────────────
    // Views: profiles & ownership
    // ────────────────────────────────────────────────────────────────────────────────────────

    /// @inheritdoc INuraProfile
    function profileIdOf(address owner) external view returns (uint256) {
        return _layout().profileIdOf[owner];
    }

    /// @inheritdoc INuraProfile
    function ownerOf(uint256 profileId) external view returns (address) {
        return _layout().profiles[profileId].owner;
    }

    /// @inheritdoc INuraProfile
    function exists(uint256 profileId) external view returns (bool) {
        return _layout().profiles[profileId].owner != address(0);
    }

    /// @inheritdoc INuraProfile
    function pendingOwnerOf(uint256 profileId) external view returns (address) {
        return _layout().profiles[profileId].pendingOwner;
    }

    /// @inheritdoc INuraProfile
    function recoveryAddressOf(uint256 profileId) external view returns (address) {
        return _layout().profiles[profileId].recovery;
    }

    /// @inheritdoc INuraProfile
    function isOperator(address owner, address operator) external view returns (bool) {
        return _layout().operators[owner][operator];
    }

    /// @inheritdoc INuraProfile
    function isAuthorized(uint256 profileId, address account) external view returns (bool) {
        Layout storage $ = _layout();
        address owner = $.profiles[profileId].owner;
        return owner != address(0) && (account == owner || $.operators[owner][account]);
    }

    /// @inheritdoc INuraProfile
    function profilesCreated() external view returns (uint256) {
        return _layout().nextProfileId;
    }

    /// @inheritdoc INuraProfile
    function getProfileRecord(uint256 profileId) external view returns (ProfileRecordView memory r) {
        ProfileRecord storage p = _requireProfile(_layout(), profileId);
        r.owner = p.owner;
        r.username = p.username.toString();
        r.createdAt = p.createdAt;
        r.updatedAt = p.updatedAt;
        r.pendingOwner = p.pendingOwner;
        r.recovery = p.recovery;
        r.itemsCreated = p.nextItemId;
    }

    // ────────────────────────────────────────────────────────────────────────────────────────
    // Views: usernames
    // ────────────────────────────────────────────────────────────────────────────────────────

    /// @inheritdoc INuraProfile
    function usernameOf(uint256 profileId) external view returns (string memory) {
        return _requireProfile(_layout(), profileId).username.toString();
    }

    /// @inheritdoc INuraProfile
    function resolveUsername(string calldata username) external view returns (uint256 profileId, address owner) {
        (bool ok, bytes32 key) = username.tryUsername();
        if (!ok) return (0, address(0));
        Layout storage $ = _layout();
        profileId = $.usernameToProfile[key];
        owner = $.profiles[profileId].owner;
    }

    /// @inheritdoc INuraProfile
    function isUsernameAvailable(string calldata username) external view returns (bool) {
        (bool ok, bytes32 key) = username.tryUsername();
        if (!ok) return false;
        Layout storage $ = _layout();
        return $.usernameToProfile[key] == 0 && !$.reservations[key].active;
    }

    /// @inheritdoc INuraProfile
    function normalizeUsername(string calldata username) external pure returns (string memory) {
        return username.toUsername().toString();
    }

    /// @inheritdoc INuraProfile
    function usernameReservation(string calldata username) external view returns (address claimant, bool active) {
        Reservation storage r = _layout().reservations[username.toUsername()];
        return (r.claimant, r.active);
    }

    // ────────────────────────────────────────────────────────────────────────────────────────
    // Views: fields
    // ────────────────────────────────────────────────────────────────────────────────────────

    /// @inheritdoc INuraProfile
    function getField(uint256 profileId, string calldata key) external view returns (string memory) {
        Layout storage $ = _layout();
        _requireProfile($, profileId);
        return $.fields[profileId][key.toKey()][0];
    }

    /// @inheritdoc INuraProfile
    function getLocalizedField(uint256 profileId, string calldata key, string calldata lang)
        external
        view
        returns (string memory)
    {
        Layout storage $ = _layout();
        _requireProfile($, profileId);
        return $.fields[profileId][key.toKey()][lang.toLang()];
    }

    /// @inheritdoc INuraProfile
    function resolveField(uint256 profileId, string calldata key, string calldata lang)
        external
        view
        returns (string memory)
    {
        Layout storage $ = _layout();
        _requireProfile($, profileId);
        return _resolve($.fields[profileId][key.toKey()], lang.toLang());
    }

    /// @inheritdoc INuraProfile
    function resolveFields(uint256 profileId, string[] calldata keys, string calldata lang)
        external
        view
        returns (string[] memory values)
    {
        Layout storage $ = _layout();
        _requireProfile($, profileId);
        return _resolveMany($.fields[profileId], keys, lang.toLang());
    }

    // ────────────────────────────────────────────────────────────────────────────────────────
    // Views: items
    // ────────────────────────────────────────────────────────────────────────────────────────

    /// @inheritdoc INuraProfile
    function getItemIds(uint256 profileId, string calldata kind) external view returns (uint256[] memory out) {
        Layout storage $ = _layout();
        _requireProfile($, profileId);
        uint32[] storage ids = $.itemIds[profileId][kind.toKind()];
        uint256 n = ids.length;
        out = new uint256[](n);
        for (uint256 i = 0; i < n; ) {
            out[i] = ids[i];
            unchecked {
                ++i;
            }
        }
    }

    /// @inheritdoc INuraProfile
    function getItemCount(uint256 profileId, string calldata kind) external view returns (uint256) {
        Layout storage $ = _layout();
        _requireProfile($, profileId);
        return $.itemIds[profileId][kind.toKind()].length;
    }

    /// @inheritdoc INuraProfile
    function getItemKind(uint256 profileId, uint256 itemId) external view returns (string memory) {
        Layout storage $ = _layout();
        _requireProfile($, profileId);
        return bytes32($.items[profileId][itemId].kind).toString();
    }

    /// @inheritdoc INuraProfile
    function getItemAttribute(uint256 profileId, uint256 itemId, string calldata key, string calldata lang)
        external
        view
        returns (string memory)
    {
        Layout storage $ = _layout();
        _requireProfile($, profileId);
        _requireItem($, profileId, itemId);
        return $.itemAttributes[profileId][itemId][key.toKey()][lang.toLang()];
    }

    /// @inheritdoc INuraProfile
    function resolveItemAttribute(uint256 profileId, uint256 itemId, string calldata key, string calldata lang)
        external
        view
        returns (string memory)
    {
        Layout storage $ = _layout();
        _requireProfile($, profileId);
        _requireItem($, profileId, itemId);
        return _resolve($.itemAttributes[profileId][itemId][key.toKey()], lang.toLang());
    }

    /// @inheritdoc INuraProfile
    function resolveItemAttributes(uint256 profileId, uint256 itemId, string[] calldata keys, string calldata lang)
        external
        view
        returns (string[] memory values)
    {
        Layout storage $ = _layout();
        _requireProfile($, profileId);
        _requireItem($, profileId, itemId);
        return _resolveMany($.itemAttributes[profileId][itemId], keys, lang.toLang());
    }

    // ────────────────────────────────────────────────────────────────────────────────────────
    // Views: extensions
    // ────────────────────────────────────────────────────────────────────────────────────────

    /// @inheritdoc INuraProfile
    function getExtension(string calldata extensionId) external view returns (address) {
        return _layout().extensions[extensionId.toKey()];
    }

    /// @inheritdoc INuraProfile
    function extensionIdOf(address extension) external view returns (bytes32) {
        return _layout().extensionIdOf[extension];
    }

    /// @inheritdoc INuraProfile
    function getExtensions() external view returns (bytes32[] memory ids, address[] memory extensions) {
        Layout storage $ = _layout();
        ids = $.extensionIds;
        uint256 n = ids.length;
        extensions = new address[](n);
        for (uint256 i = 0; i < n; ) {
            extensions[i] = $.extensions[ids[i]];
            unchecked {
                ++i;
            }
        }
    }

    /// @inheritdoc INuraProfile
    function isExtensionApproved(uint256 profileId, string calldata extensionId) external view returns (bool) {
        return _layout().extensionApprovals[profileId][extensionId.toKey()];
    }

    /// @inheritdoc INuraProfile
    function getExtensionField(
        uint256 profileId,
        string calldata extensionId,
        string calldata key,
        string calldata lang
    ) external view returns (string memory) {
        Layout storage $ = _layout();
        _requireProfile($, profileId);
        return $.extensionFields[profileId][extensionId.toKey()][key.toKey()][lang.toLang()];
    }

    // ────────────────────────────────────────────────────────────────────────────────────────
    // Internal: authorization
    // ────────────────────────────────────────────────────────────────────────────────────────

    function _requireProfile(Layout storage $, uint256 profileId) private view returns (ProfileRecord storage p) {
        p = $.profiles[profileId];
        if (p.owner == address(0)) revert ProfileNotFound(profileId);
    }

    /// @dev Owner or an operator approved by the owner: the content-editing permission.
    function _requireAuthorized(Layout storage $, uint256 profileId) private view returns (ProfileRecord storage p) {
        p = $.profiles[profileId];
        address owner = p.owner;
        if (owner == address(0)) revert ProfileNotFound(profileId);
        if (msg.sender != owner && !$.operators[owner][msg.sender]) revert NotAuthorized(profileId, msg.sender);
    }

    /// @dev Owner only: identity-level actions (rename, delete, recovery, extension approvals).
    function _requireOwner(Layout storage $, uint256 profileId) private view returns (ProfileRecord storage p) {
        p = $.profiles[profileId];
        if (p.owner == address(0)) revert ProfileNotFound(profileId);
        if (msg.sender != p.owner) revert NotProfileOwner(profileId, msg.sender);
    }

    /// @dev Owner or the recovery address: transfer initiation and cancellation.
    function _requireOwnerOrRecovery(Layout storage $, uint256 profileId)
        private
        view
        returns (ProfileRecord storage p)
    {
        p = $.profiles[profileId];
        if (p.owner == address(0)) revert ProfileNotFound(profileId);
        if (msg.sender != p.owner && msg.sender != p.recovery) revert NotOwnerOrRecovery(profileId, msg.sender);
    }

    function _requireItem(Layout storage $, uint256 profileId, uint256 itemId) private view {
        if ($.items[profileId][itemId].kind == 0) revert ItemNotFound(itemId);
    }

    function _requireKind(Layout storage $, uint256 profileId, uint256 itemId, bytes32 kind) private view {
        bytes32 actual = bytes32($.items[profileId][itemId].kind);
        if (actual == 0) revert ItemNotFound(itemId);
        if (actual != kind) revert ItemKindMismatch(itemId, kind, actual);
    }

    // ────────────────────────────────────────────────────────────────────────────────────────
    // Internal: storage helpers
    // ────────────────────────────────────────────────────────────────────────────────────────

    /// @dev Writes `value` under `lang`, or deletes the entry when `value` is empty.
    /// @return set True when a value was stored, false when the entry was removed.
    function _store(mapping(bytes32 lang => string value) storage byLang, bytes32 lang, string calldata value)
        private
        returns (bool set)
    {
        uint256 len = bytes(value).length;
        if (len == 0) {
            delete byLang[lang];
            return false;
        }
        if (len > MAX_VALUE_LENGTH) revert ValueTooLong(len, MAX_VALUE_LENGTH);
        byLang[lang] = value;
        return true;
    }

    /// @dev Value in `lang`, or the default value when `lang` is unset or has no entry.
    function _resolve(mapping(bytes32 lang => string value) storage byLang, bytes32 lang)
        private
        view
        returns (string memory value)
    {
        if (lang != 0) {
            value = byLang[lang];
            if (bytes(value).length != 0) return value;
        }
        return byLang[0];
    }

    /// @dev Records the mutation: bumps `updatedAt` and emits the catch-all event.
    function _touch(ProfileRecord storage p, uint256 profileId) private {
        p.updatedAt = uint40(block.timestamp);
        emit ProfileUpdated(profileId);
    }

    /// @dev Resolves several keys of one (key => lang => value) map in `lang` with default fallback.
    function _resolveMany(
        mapping(bytes32 key => mapping(bytes32 lang => string value)) storage byKey,
        string[] calldata keys,
        bytes32 lang
    ) private view returns (string[] memory values) {
        uint256 n = keys.length;
        values = new string[](n);
        for (uint256 i = 0; i < n; ) {
            values[i] = _resolve(byKey[keys[i].toKey()], lang);
            unchecked {
                ++i;
            }
        }
    }
}
