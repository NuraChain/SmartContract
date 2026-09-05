// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {InvalidKey, InvalidKind, InvalidLanguage, InvalidUsername} from "../ProfileErrors.sol";

/**
 * @title ProfileStrings
 * @notice Validation and packing for the short identifiers the profile system keys its
 *         storage by: field keys, item kinds, language tags and usernames. Each one is an
 *         ASCII string of at most 32 bytes that is stored and emitted as a `bytes32` short
 *         string (left-aligned, zero-padded), so it costs one word and stays readable.
 *
 * @dev All functions are `internal` and operate on memory; the callers pass 32-byte-ish
 *      identifiers, so the loops here are bounded by construction (never more than 32
 *      iterations) — the length check runs before the loop.
 *
 *      Only ASCII is normalized. Unicode case-folding on-chain is neither cheap nor
 *      well-defined, so usernames are restricted to [a-z0-9_] and language tags to
 *      [a-z0-9-]; anything else is rejected rather than guessed at.
 */
library ProfileStrings {
    uint256 internal constant MAX_KEY_LENGTH = 32;
    uint256 internal constant MAX_KIND_LENGTH = 28;
    uint256 internal constant MAX_LANGUAGE_LENGTH = 32;
    uint256 internal constant MIN_USERNAME_LENGTH = 3;
    uint256 internal constant MAX_USERNAME_LENGTH = 32;

    /**
     * @notice Packs a field / attribute key. 1..32 bytes, each printable non-space ASCII
     *         (0x21..0x7E). Case is preserved — keys are developer identifiers.
     */
    function toKey(string memory key) internal pure returns (bytes32) {
        bytes memory b = bytes(key);
        uint256 len = b.length;
        if (len == 0 || len > MAX_KEY_LENGTH) revert InvalidKey();
        if (!_isPrintable(b, len)) revert InvalidKey();
        return _pack(b, len);
    }

    /**
     * @notice Packs an item kind. Same alphabet as a key, but at most 28 bytes so the kind
     *         shares a storage slot with the item's position index.
     */
    function toKind(string memory kind) internal pure returns (bytes32) {
        bytes memory b = bytes(kind);
        uint256 len = b.length;
        if (len == 0 || len > MAX_KIND_LENGTH) revert InvalidKind();
        if (!_isPrintable(b, len)) revert InvalidKind();
        return _pack(b, len);
    }

    /**
     * @notice Packs a language tag. Empty means the default language and packs to zero.
     *         Otherwise 1..32 bytes of [A-Za-z0-9-], lower-cased (BCP-47 is case-insensitive,
     *         so "pt-BR" and "pt-br" address the same value).
     */
    function toLang(string memory lang) internal pure returns (bytes32) {
        bytes memory b = bytes(lang);
        uint256 len = b.length;
        if (len == 0) return bytes32(0);
        if (len > MAX_LANGUAGE_LENGTH) revert InvalidLanguage();

        for (uint256 i = 0; i < len; ) {
            bytes1 c = b[i];
            if (c >= 0x41 && c <= 0x5A) {
                b[i] = bytes1(uint8(c) + 32); // A-Z -> a-z
            } else if (!((c >= 0x61 && c <= 0x7A) || (c >= 0x30 && c <= 0x39) || c == 0x2D)) {
                revert InvalidLanguage();
            }
            unchecked {
                ++i;
            }
        }
        return _pack(b, len);
    }

    /**
     * @notice Normalizes a username and reverts if it is invalid. Rules:
     *         - 3..32 bytes
     *         - ASCII letters are lower-cased; after that only [a-z0-9_] may remain
     *         - may not start with "0x", so a handle can never be mistaken for an address
     */
    function toUsername(string memory username) internal pure returns (bytes32) {
        (bool ok, bytes32 key) = tryUsername(username);
        if (!ok) revert InvalidUsername();
        return key;
    }

    /// @notice Non-reverting variant of {toUsername}, for resolvers and availability checks.
    function tryUsername(string memory username) internal pure returns (bool ok, bytes32 key) {
        bytes memory b = bytes(username);
        uint256 len = b.length;
        if (len < MIN_USERNAME_LENGTH || len > MAX_USERNAME_LENGTH) return (false, 0);

        for (uint256 i = 0; i < len; ) {
            bytes1 c = b[i];
            if (c >= 0x41 && c <= 0x5A) {
                b[i] = bytes1(uint8(c) + 32); // A-Z -> a-z
            } else if (!((c >= 0x61 && c <= 0x7A) || (c >= 0x30 && c <= 0x39) || c == 0x5F)) {
                return (false, 0);
            }
            unchecked {
                ++i;
            }
        }
        if (b[0] == 0x30 && b[1] == 0x78) return (false, 0); // "0x"
        return (true, _pack(b, len));
    }

    /// @notice Unpacks a `bytes32` short string back into a string (trailing zero bytes dropped).
    function toString(bytes32 value) internal pure returns (string memory out) {
        uint256 len = 0;
        while (len < 32 && value[len] != 0) {
            unchecked {
                ++len;
            }
        }
        out = new string(len);
        // `new string(len)` rounds its allocation up to a whole word, so writing all 32 bytes
        // stays inside it; the bytes past `len` are the zero padding of `value`.
        assembly ("memory-safe") {
            mstore(add(out, 0x20), value)
        }
    }

    /// @dev True when every byte is printable ASCII other than space (0x21..0x7E).
    function _isPrintable(bytes memory b, uint256 len) private pure returns (bool) {
        for (uint256 i = 0; i < len; ) {
            bytes1 c = b[i];
            if (c < 0x21 || c > 0x7E) return false;
            unchecked {
                ++i;
            }
        }
        return true;
    }

    /**
     * @dev Left-aligns the first `len` bytes of `b` in a word, zeroing the rest. The mask is
     *      not optional: the ABI decoder does not promise the padding after a `string`
     *      argument is clean, and a caller could plant bytes there.
     */
    function _pack(bytes memory b, uint256 len) private pure returns (bytes32 out) {
        assembly ("memory-safe") {
            out := mload(add(b, 0x20))
        }
        if (len < 32) {
            uint256 shift = 8 * (32 - len);
            out = bytes32((uint256(out) >> shift) << shift);
        }
    }
}
