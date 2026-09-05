// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title ProfileErrors
 * @notice File-level custom errors shared by the profile core, its string library and its
 *         extensions. Declared once at file scope so the library can revert with the same
 *         errors the core advertises in its ABI, and so every consumer decodes one set.
 */

// ── profiles ─────────────────────────────────────────────────────────────────────────────

/// @dev No profile exists under this id (never created, or deleted).
error ProfileNotFound(uint256 profileId);
/// @dev The address already owns a profile; an address can own at most one.
error AlreadyHasProfile(address account);
/// @dev Caller is neither the profile owner nor an approved operator of the owner.
error NotAuthorized(uint256 profileId, address account);
/// @dev Caller is not the profile owner (operators are not enough for this action).
error NotProfileOwner(uint256 profileId, address account);
/// @dev Caller is neither the profile owner nor its recovery address.
error NotOwnerOrRecovery(uint256 profileId, address account);
/// @dev Caller is not the pending owner of this profile transfer.
error NotPendingOwner(uint256 profileId, address account);
/// @dev There is no transfer in progress for this profile.
error NoPendingTransfer(uint256 profileId);
/// @dev A zero address was supplied where a real address is required.
error ZeroAddress();
/// @dev The address is invalid in this position (e.g. transferring to yourself).
error InvalidAddress(address account);

// ── usernames ────────────────────────────────────────────────────────────────────────────

/// @dev Username fails validation: length 3..32 after lower-casing, chars [a-z0-9_], no "0x" prefix.
error InvalidUsername();
/// @dev Username is already registered to another profile.
error UsernameTaken(bytes32 username);
/// @dev Username is reserved for someone else (or for nobody).
error UsernameIsReserved(bytes32 username);
/// @dev The new username normalizes to the one the profile already has.
error UsernameUnchanged(bytes32 username);

// ── keys, languages, values ──────────────────────────────────────────────────────────────

/// @dev Field / attribute key must be 1..32 bytes of printable, non-space ASCII.
error InvalidKey();
/// @dev Item kind must be 1..28 bytes of printable, non-space ASCII.
error InvalidKind();
/// @dev Language tag must be 1..32 bytes of [A-Za-z0-9-] (empty means default).
error InvalidLanguage();
/// @dev Stored value exceeds `MAX_VALUE_LENGTH` bytes.
error ValueTooLong(uint256 length, uint256 maxLength);

// ── items ────────────────────────────────────────────────────────────────────────────────

/// @dev No item with this id on the profile (never added, or removed).
error ItemNotFound(uint256 itemId);
/// @dev The item exists but is not of the kind this typed function operates on.
error ItemKindMismatch(uint256 itemId, bytes32 expectedKind, bytes32 actualKind);

// ── extensions ───────────────────────────────────────────────────────────────────────────

/// @dev The extension id or address is already in the registry.
error ExtensionAlreadyRegistered(bytes32 extensionId);
/// @dev Caller (or the named id) is not a registered extension.
error ExtensionNotRegistered(bytes32 extensionId);
/// @dev The profile owner has not approved this extension to write to their profile.
error ExtensionNotApproved(uint256 profileId, bytes32 extensionId);
/// @dev The address does not implement IProfileExtension, or serves a different registry.
error InvalidExtension(address extension);
/// @dev The extension reports an id other than the one it is being registered under.
error ExtensionIdMismatch(bytes32 expected, bytes32 reported);
