// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import {NuraProfile} from "../NuraProfile.sol";
import {INuraProfile} from "../interfaces/INuraProfile.sol";
import {IProfileExtension} from "../interfaces/IProfileExtension.sol";

/**
 * Test doubles for the profile system. Nothing here is deployed.
 */

/**
 * @dev A configurable extension: reports whatever id / registry it is told to, so the
 *      registration handshake can be tested in every failure mode, and forwards writes to
 *      the core so the namespace rules can be exercised.
 */
contract MockExtension is IProfileExtension {
    INuraProfile public immutable registry;
    bytes32 public reportedId;
    address public reportedRegistry;
    bool public claimsInterface = true;

    constructor(address registry_, bytes32 id) {
        registry = INuraProfile(registry_);
        reportedId = id;
        reportedRegistry = registry_;
    }

    function setReportedId(bytes32 id) external {
        reportedId = id;
    }

    function setReportedRegistry(address r) external {
        reportedRegistry = r;
    }

    function setClaimsInterface(bool v) external {
        claimsInterface = v;
    }

    function extensionId() external view returns (bytes32) {
        return reportedId;
    }

    function profileRegistry() external view returns (address) {
        return reportedRegistry;
    }

    function supportsInterface(bytes4 interfaceId) external view returns (bool) {
        if (interfaceId == type(IERC165).interfaceId) return true;
        return claimsInterface && interfaceId == type(IProfileExtension).interfaceId;
    }

    function write(uint256 profileId, string calldata key, string calldata lang, string calldata value) external {
        registry.setExtensionField(profileId, key, lang, value);
    }

    function remove(uint256 profileId, string calldata id, string calldata key, string calldata lang) external {
        registry.removeExtensionField(profileId, id, key, lang);
    }
}

/// @dev Not an extension at all: no ERC-165. Registration must reject it cleanly.
contract NotAnExtension {
    function extensionId() external pure returns (bytes32) {
        return "impostor";
    }
}

/**
 * @dev The shape a real V2 would take: inherits V1 unchanged (so V1's namespaced layout is
 *      untouched), adds its own ERC-7201 namespace for new state, a reinitializer, and new
 *      functions. Used to prove an upgrade keeps every V1 profile intact.
 */
contract NuraProfileV2Mock is NuraProfile {
    /// @custom:storage-location erc7201:nura.storage.NuraProfileV2Mock
    struct LayoutV2 {
        uint256 counter;
        string greeting;
    }

    // keccak256(abi.encode(uint256(keccak256("nura.storage.NuraProfileV2Mock")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant LAYOUT_V2_SLOT = 0x9da54fb579789c065c28faab30226bd4594736832e3133c8a7cc6ebc1c09d600;

    function _layoutV2() private pure returns (LayoutV2 storage $) {
        assembly ("memory-safe") {
            $.slot := LAYOUT_V2_SLOT
        }
    }

    function initializeV2(string calldata greeting_) external reinitializer(2) {
        _layoutV2().greeting = greeting_;
    }

    function version() external pure returns (string memory) {
        return "2.0.0-mock";
    }

    function greeting() external view returns (string memory) {
        return _layoutV2().greeting;
    }

    function bump() external returns (uint256) {
        return ++_layoutV2().counter;
    }

    /// @dev Exposes V1's namespace slot so a test can pin the ERC-7201 derivation.
    function layoutSlot() external pure returns (bytes32) {
        return LAYOUT_SLOT;
    }
}
