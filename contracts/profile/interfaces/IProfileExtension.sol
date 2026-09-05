// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/**
 * @title IProfileExtension
 * @notice The handshake a contract must pass to be registered as a profile extension.
 *
 * Extensions are sidecar contracts: they keep their own storage and logic, read the core
 * through `INuraProfile` (ownership, operators, fields), and — once a profile owner has
 * approved them — may write small attested values into their own namespace of that profile
 * via `INuraProfile.setExtensionField`. The core never delegatecalls into an extension and
 * never calls out to one during user actions, so a broken or malicious extension can at
 * worst write junk into its own namespace, which the owner can clear and the admin can
 * cut off by unregistering it.
 *
 * @dev `extensionId` must equal the id the extension is registered under and
 *      `profileRegistry` must be the core it is being registered on. Both are checked at
 *      registration, so an extension built for one deployment cannot be registered on
 *      another by mistake.
 */
interface IProfileExtension is IERC165 {
    /// @notice The registry key this extension is meant to be registered under (short string).
    function extensionId() external view returns (bytes32);

    /// @notice The NuraProfile core this extension serves.
    function profileRegistry() external view returns (address);
}
