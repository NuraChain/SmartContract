// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {INuraProfile} from "../interfaces/INuraProfile.sol";
import {IProfileExtension} from "../interfaces/IProfileExtension.sol";
import {ProfileStrings} from "../libraries/ProfileStrings.sol";

/**
 * @title SocialVerifier
 * @notice Reference profile extension: proves that a profile controls an account on an
 *         external platform (GitHub, X, Telegram, Farcaster, ...) and records the verified
 *         handle on the profile, where wallets can show a "verified" badge next to the
 *         matching social entry.
 *
 * Flow:
 *   1. The profile owner approves this extension once: `NuraProfile.approveExtension(id,
 *      "social-verifier", true)`.
 *   2. Off-chain, a backend holding VERIFIER_ROLE completes the platform's OAuth (or any
 *      other proof) and signs an EIP-712 `VerifyHandle` for (profileId, platform, handle).
 *   3. The owner (or an operator) submits the signature to `verifyHandle`, which writes
 *      `handle` under key `platform` in this extension's namespace on the core:
 *      `getExtensionField(profileId, "social-verifier", "github", "")`.
 *
 * What this demonstrates about the extension model: the extension keeps its own state
 * (nonces), reads authorization from the core (`isAuthorized`), passes the registration
 * handshake (`IProfileExtension`), and writes only into its own namespace — the core never
 * calls back into it. The signer decides what "verified" means; the chain only records it.
 *
 * @dev Signatures are bound to this contract and chain through the EIP-712 domain, to the
 *      profile through `profileId`, and to one use through the per-profile nonce.
 */
contract SocialVerifier is IProfileExtension, AccessControl, EIP712 {
    using ProfileStrings for string;

    /// @notice Signs verification attestations (a backend key). Also revokes.
    bytes32 public constant VERIFIER_ROLE = keccak256("VERIFIER_ROLE");

    /// @notice Registry id: the namespace this extension writes under on the core.
    bytes32 public constant EXTENSION_ID = "social-verifier";

    bytes32 private constant VERIFY_TYPEHASH =
        keccak256("VerifyHandle(uint256 profileId,string platform,string handle,uint256 nonce,uint256 deadline)");

    /// @notice The NuraProfile core this extension serves.
    INuraProfile public immutable registry;

    /// @notice Next nonce per profile; every accepted signature consumes one.
    mapping(uint256 profileId => uint256 nonce) public nonces;

    /// @notice A handle was verified and written to the profile.
    event HandleVerified(uint256 indexed profileId, bytes32 indexed platform, string handle, address indexed signer);
    /// @notice A verification was revoked by a verifier.
    event HandleRevoked(uint256 indexed profileId, bytes32 indexed platform);

    error ZeroAddress();
    error NotAuthorized(uint256 profileId, address account);
    error SignatureExpired(uint256 deadline);
    error InvalidSignature();

    /**
     * @param admin     Receives DEFAULT_ADMIN_ROLE: manages verifiers.
     * @param verifier  Backend key that signs attestations. Receives VERIFIER_ROLE.
     * @param registry_ The NuraProfile proxy address.
     */
    constructor(address admin, address verifier, address registry_) EIP712("NuraSocialVerifier", "1") {
        if (admin == address(0) || verifier == address(0) || registry_ == address(0)) revert ZeroAddress();
        registry = INuraProfile(registry_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(VERIFIER_ROLE, verifier);
    }

    // ── IProfileExtension ────────────────────────────────────────────────────────────────

    /// @inheritdoc IProfileExtension
    function extensionId() external pure returns (bytes32) {
        return EXTENSION_ID;
    }

    /// @inheritdoc IProfileExtension
    function profileRegistry() external view returns (address) {
        return address(registry);
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) public view override(AccessControl, IERC165) returns (bool) {
        return interfaceId == type(IProfileExtension).interfaceId || super.supportsInterface(interfaceId);
    }

    // ── verification ─────────────────────────────────────────────────────────────────────

    /**
     * @notice Records `handle` as the profile's verified account on `platform`, given a
     *         VERIFIER_ROLE signature over (profileId, platform, handle, nonce, deadline).
     * @dev Only the profile owner or an operator may submit, so nobody can attach a
     *      verification to a profile that did not ask for it. The core additionally requires
     *      the owner to have approved this extension.
     */
    function verifyHandle(
        uint256 profileId,
        string calldata platform,
        string calldata handle,
        uint256 deadline,
        bytes calldata signature
    ) external {
        if (!registry.isAuthorized(profileId, msg.sender)) revert NotAuthorized(profileId, msg.sender);
        if (block.timestamp > deadline) revert SignatureExpired(deadline);

        uint256 nonce = nonces[profileId]++;
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    VERIFY_TYPEHASH, profileId, keccak256(bytes(platform)), keccak256(bytes(handle)), nonce, deadline
                )
            )
        );
        address signer = ECDSA.recover(digest, signature);
        if (!hasRole(VERIFIER_ROLE, signer)) revert InvalidSignature();

        registry.setExtensionField(profileId, platform, "", handle);
        emit HandleVerified(profileId, platform.toKey(), handle, signer);
    }

    /// @notice Removes a verification, e.g. after the platform account changed hands.
    function revokeHandle(uint256 profileId, string calldata platform) external onlyRole(VERIFIER_ROLE) {
        registry.removeExtensionField(profileId, "social-verifier", platform, "");
        emit HandleRevoked(profileId, platform.toKey());
    }

    /// @notice The verified handle for `platform`, or empty. Convenience over the core getter.
    function verifiedHandle(uint256 profileId, string calldata platform) external view returns (string memory) {
        return registry.getExtensionField(profileId, "social-verifier", platform, "");
    }

    /// @notice EIP-712 digest a verifier must sign for the next nonce of `profileId`.
    function hashVerifyHandle(uint256 profileId, string calldata platform, string calldata handle, uint256 deadline)
        external
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    VERIFY_TYPEHASH,
                    profileId,
                    keccak256(bytes(platform)),
                    keccak256(bytes(handle)),
                    nonces[profileId],
                    deadline
                )
            )
        );
    }
}
