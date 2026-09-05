// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {NuraProfile} from "../NuraProfile.sol";
import {NuraProfileProxy} from "../NuraProfileProxy.sol";
import {FieldInput} from "../ProfileTypes.sol";
import {InvalidKey, InvalidKind, InvalidLanguage, InvalidUsername, UsernameTaken, ValueTooLong} from "../ProfileErrors.sol";

/**
 * Property tests for NuraProfile, run by `npx hardhat test solidity`.
 *
 * test/Profile.test.ts pins the behaviour at chosen inputs. These say the same things for
 * inputs nobody chose: any username that normalizes the same must collide, any value that
 * fits must read back byte for byte, any language tag must be case-insensitive, and no
 * sequence of adds and removes may leave a kind's list inconsistent.
 *
 * @dev Cheatcodes are reached through the hevm address directly rather than through
 *      forge-std, which this repo does not depend on. Hardhat 3 runs these natively.
 */
interface Vm {
    function assume(bool condition) external pure;
    function expectRevert(bytes calldata revertData) external;
    function prank(address sender) external;
}

contract ProfileFuzzTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);

    /// @dev Every byte a normalized username may contain, plus the upper-case letters that fold onto it.
    bytes private constant USERNAME_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    /// @dev Every byte a language tag may contain.
    bytes private constant LANG_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ";

    NuraProfile private profile;

    function setUp() public {
        NuraProfile impl = new NuraProfile();
        NuraProfileProxy proxy =
            new NuraProfileProxy(address(impl), abi.encodeCall(NuraProfile.initialize, (address(this))));
        profile = NuraProfile(address(proxy));
    }

    // -------------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------------

    /** A username built from `seed`: 3..32 bytes of the username alphabet, not starting with 0x. */
    function _username(bytes32 seed, uint8 lenSeed) private pure returns (string memory) {
        uint256 len = 3 + (uint256(lenSeed) % 30);
        bytes memory b = new bytes(len);
        for (uint256 i = 0; i < len; i++) {
            b[i] = USERNAME_ALPHABET[uint8(seed[i % 32]) % USERNAME_ALPHABET.length];
        }
        if (b[0] == "0" && (b[1] == "x" || b[1] == "X")) b[0] = "a";
        return string(b);
    }

    /** ASCII lower-casing, the reference the contract must agree with. */
    function _lower(string memory s) private pure returns (string memory) {
        bytes memory b = bytes(s);
        for (uint256 i = 0; i < b.length; i++) {
            if (b[i] >= 0x41 && b[i] <= 0x5A) b[i] = bytes1(uint8(b[i]) + 32);
        }
        return string(b);
    }

    /** ASCII upper-casing, to derive a differently-cased spelling of the same name. */
    function _upper(string memory s) private pure returns (string memory) {
        bytes memory b = bytes(s);
        for (uint256 i = 0; i < b.length; i++) {
            if (b[i] >= 0x61 && b[i] <= 0x7A) b[i] = bytes1(uint8(b[i]) - 32);
        }
        return string(b);
    }

    /** A key of `len` (1..32) printable non-space ASCII bytes. */
    function _key(bytes32 seed, uint8 lenSeed) private pure returns (string memory) {
        uint256 len = 1 + (uint256(lenSeed) % 32);
        bytes memory b = new bytes(len);
        for (uint256 i = 0; i < len; i++) {
            b[i] = bytes1(uint8(0x21 + (uint8(seed[i % 32]) % 94))); // 0x21..0x7E
        }
        return string(b);
    }

    /** A language tag of `len` (1..32) bytes of the language alphabet. */
    function _lang(bytes32 seed, uint8 lenSeed) private pure returns (string memory) {
        uint256 len = 1 + (uint256(lenSeed) % 32);
        bytes memory b = new bytes(len);
        for (uint256 i = 0; i < len; i++) {
            b[i] = LANG_ALPHABET[uint8(seed[i % 32]) % LANG_ALPHABET.length];
        }
        return string(b);
    }

    function _eq(string memory a, string memory b) private pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    // -------------------------------------------------------------------------------
    // Usernames
    // -------------------------------------------------------------------------------

    /// @dev Normalization is ASCII lower-casing, and is idempotent.
    function testFuzz_usernameNormalizesToLowercase(bytes32 seed, uint8 lenSeed) public view {
        string memory name = _username(seed, lenSeed);
        string memory normalized = profile.normalizeUsername(name);

        assert(_eq(normalized, _lower(name)));
        assert(_eq(profile.normalizeUsername(normalized), normalized));
        assert(_eq(profile.normalizeUsername(_upper(name)), normalized));
    }

    /// @dev Two spellings that fold to the same name are one name: the second registration collides.
    function testFuzz_differentlyCasedUsernamesCollide(bytes32 seed, uint8 lenSeed) public {
        string memory name = _username(seed, lenSeed);
        string memory other = _upper(name);

        vm.prank(ALICE);
        profile.createProfile(name, "", "", "");

        (uint256 id, address owner) = profile.resolveUsername(other);
        assert(id == 1 && owner == ALICE);
        assert(!profile.isUsernameAvailable(other));

        bytes32 key;
        {
            bytes memory lower = bytes(_lower(name));
            assembly ("memory-safe") {
                key := mload(add(lower, 0x20))
            }
            uint256 shift = 8 * (32 - lower.length);
            if (lower.length < 32) key = bytes32((uint256(key) >> shift) << shift);
        }
        vm.prank(BOB);
        vm.expectRevert(abi.encodeWithSelector(UsernameTaken.selector, key));
        profile.createProfile(other, "", "", "");
    }

    /// @dev One byte outside the alphabet anywhere in the name is enough to reject it.
    function testFuzz_usernameRejectsForeignByte(bytes32 seed, uint8 lenSeed, uint8 position, uint8 foreign) public {
        bytes memory b = bytes(_username(seed, lenSeed));
        bool allowed = (foreign >= 0x30 && foreign <= 0x39) || (foreign >= 0x41 && foreign <= 0x5A)
            || (foreign >= 0x61 && foreign <= 0x7A) || foreign == 0x5F;
        vm.assume(!allowed);

        b[position % b.length] = bytes1(foreign);

        vm.expectRevert(abi.encodeWithSelector(InvalidUsername.selector));
        profile.normalizeUsername(string(b));
        assert(!profile.isUsernameAvailable(string(b)));
    }

    /// @dev Length is enforced on both sides.
    function testFuzz_usernameLengthBounds(uint8 len) public {
        vm.assume(len < 3 || len > 32);
        bytes memory b = new bytes(len);
        for (uint256 i = 0; i < len; i++) b[i] = "a";

        vm.expectRevert(abi.encodeWithSelector(InvalidUsername.selector));
        profile.normalizeUsername(string(b));
    }

    // -------------------------------------------------------------------------------
    // Fields and languages
    // -------------------------------------------------------------------------------

    /// @dev Whatever bytes go in come back, under any valid key, up to the cap.
    function testFuzz_fieldRoundTrip(bytes32 keySeed, uint8 keyLen, bytes calldata value) public {
        vm.assume(value.length > 0 && value.length <= 4096);
        string memory key = _key(keySeed, keyLen);

        vm.prank(ALICE);
        uint256 id = profile.createProfile("alice", "", "", "");

        vm.prank(ALICE);
        profile.setField(id, key, string(value));

        assert(keccak256(bytes(profile.getField(id, key))) == keccak256(value));
        assert(keccak256(bytes(profile.resolveField(id, key, "xx"))) == keccak256(value));
    }

    /// @dev Values past the cap are refused with the exact length.
    function testFuzz_valueTooLong(uint16 extra) public {
        vm.assume(extra > 0 && extra <= 2048);
        uint256 len = 4096 + uint256(extra);
        bytes memory value = new bytes(len);

        vm.prank(ALICE);
        uint256 id = profile.createProfile("alice", "", "", "");

        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(ValueTooLong.selector, len, 4096));
        profile.setField(id, "bio", string(value));
    }

    /// @dev A key with a space, control character or non-ASCII byte is never accepted.
    function testFuzz_keyRejectsUnprintable(bytes32 seed, uint8 lenSeed, uint8 position, uint8 bad) public {
        vm.assume(bad < 0x21 || bad > 0x7E);
        bytes memory b = bytes(_key(seed, lenSeed));
        b[position % b.length] = bytes1(bad);

        vm.prank(ALICE);
        uint256 id = profile.createProfile("alice", "", "", "");

        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(InvalidKey.selector));
        profile.setField(id, string(b), "x");
    }

    /// @dev Language tags are case-insensitive: any casing reads what any other casing wrote.
    function testFuzz_languageTagsFoldCase(bytes32 seed, uint8 lenSeed, bytes calldata value) public {
        vm.assume(value.length > 0 && value.length <= 256);
        string memory lang = _lang(seed, lenSeed);

        vm.prank(ALICE);
        uint256 id = profile.createProfile("alice", "", "", "");

        vm.prank(ALICE);
        profile.setLocalizedField(id, "bio", _upper(lang), string(value));

        assert(keccak256(bytes(profile.getLocalizedField(id, "bio", _lower(lang)))) == keccak256(value));
        assert(keccak256(bytes(profile.getLocalizedField(id, "bio", lang))) == keccak256(value));
        // The default stays untouched, so an unrelated language falls back to nothing.
        assert(bytes(profile.getField(id, "bio")).length == 0);
    }

    /// @dev An underscore, space or other byte outside [A-Za-z0-9-] is not a language tag.
    function testFuzz_languageRejectsForeignByte(bytes32 seed, uint8 lenSeed, uint8 position, uint8 bad) public {
        bool allowed = (bad >= 0x30 && bad <= 0x39) || (bad >= 0x41 && bad <= 0x5A) || (bad >= 0x61 && bad <= 0x7A)
            || bad == 0x2D;
        vm.assume(!allowed);
        bytes memory b = bytes(_lang(seed, lenSeed));
        b[position % b.length] = bytes1(bad);

        vm.prank(ALICE);
        uint256 id = profile.createProfile("alice", "", "", "");

        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(InvalidLanguage.selector));
        profile.setLocalizedField(id, "bio", string(b), "x");
    }

    /// @dev Localized reads fall back to the default exactly when the language has no value.
    function testFuzz_resolveFallsBackOnlyWhenUnset(bytes calldata dflt, bytes calldata local) public {
        vm.assume(dflt.length > 0 && dflt.length <= 256 && local.length <= 256);

        vm.prank(ALICE);
        uint256 id = profile.createProfile("alice", "", "", "");
        vm.prank(ALICE);
        profile.setField(id, "bio", string(dflt));
        vm.prank(ALICE);
        profile.setLocalizedField(id, "bio", "fa", string(local));

        bytes32 expected = local.length == 0 ? keccak256(dflt) : keccak256(local);
        assert(keccak256(bytes(profile.resolveField(id, "bio", "fa"))) == expected);
        assert(keccak256(bytes(profile.resolveField(id, "bio", "de"))) == keccak256(dflt));
    }

    // -------------------------------------------------------------------------------
    // Items
    // -------------------------------------------------------------------------------

    /// @dev After adding `n` items and removing one, the list has n-1 unique live ids, none of them the removed one.
    function testFuzz_removeKeepsKindListConsistent(uint8 nSeed, uint8 pickSeed) public {
        uint256 n = 1 + (uint256(nSeed) % 12);

        vm.prank(ALICE);
        uint256 id = profile.createProfile("alice", "", "", "");

        FieldInput[] memory none;
        for (uint256 i = 0; i < n; i++) {
            vm.prank(ALICE);
            profile.addItem(id, "thing", none);
        }
        uint256 victim = 1 + (uint256(pickSeed) % n);

        vm.prank(ALICE);
        profile.removeItem(id, victim);

        uint256[] memory ids = profile.getItemIds(id, "thing");
        assert(ids.length == n - 1);
        for (uint256 i = 0; i < ids.length; i++) {
            assert(ids[i] != victim);
            assert(ids[i] >= 1 && ids[i] <= n);
            for (uint256 j = i + 1; j < ids.length; j++) assert(ids[i] != ids[j]);
            assert(_eq(profile.getItemKind(id, ids[i]), "thing"));
        }
        assert(bytes(profile.getItemKind(id, victim)).length == 0);

        // The next id continues the sequence: retired ids never come back.
        vm.prank(ALICE);
        uint256 next = profile.addItem(id, "thing", none);
        assert(next == n + 1);
    }

    /// @dev A kind name of 29+ bytes is refused; 1..28 printable bytes always work.
    function testFuzz_kindLength(bytes32 seed, uint8 len) public {
        vm.assume(len > 0);
        bytes memory b = new bytes(len);
        for (uint256 i = 0; i < len; i++) b[i] = bytes1(uint8(0x21 + (uint8(seed[i % 32]) % 94)));

        vm.prank(ALICE);
        uint256 id = profile.createProfile("alice", "", "", "");
        FieldInput[] memory none;

        if (len > 28) {
            vm.prank(ALICE);
            vm.expectRevert(abi.encodeWithSelector(InvalidKind.selector));
            profile.addItem(id, string(b), none);
        } else {
            vm.prank(ALICE);
            uint256 itemId = profile.addItem(id, string(b), none);
            assert(_eq(profile.getItemKind(id, itemId), string(b)));
            assert(profile.getItemCount(id, string(b)) == 1);
        }
    }
}
