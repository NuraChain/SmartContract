// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Pausable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Pausable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title BridgeToken
 * @notice Shared base for bridged (wrapped) assets. Supply is not backed by anything
 *         on-chain: it is minted when the bridge observes a deposit on the source
 *         chain and burned when a holder exits back to it. Every unit therefore
 *         depends entirely on the bridge operator honouring the 1:1 backing.
 *
 * Roles (all four are granted to `admin` at deployment):
 *  - DEFAULT_ADMIN_ROLE: grants and revokes the roles below, and rescues stray tokens.
 *  - MINTER_ROLE: creates supply for an inbound bridge transfer.
 *  - BURNER_ROLE: destroys supply from any account, without an allowance.
 *  - PAUSER_ROLE: halts all transfers, mints and burns.
 *
 * @dev BURNER_ROLE can burn any holder's balance and PAUSER_ROLE can freeze the token.
 *      Those are deliberate operator powers, not oversights — anyone holding this token
 *      is trusting whoever holds these roles. Move them to a multisig or timelock before
 *      real value depends on them; see the README.
 */
abstract contract BridgeToken is ERC20, ERC20Burnable, ERC20Pausable, AccessControl, ERC20Permit {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    uint8 private immutable _tokenDecimals;

    /// @notice Emitted alongside the ERC20 Transfer event, recording which operator minted.
    event BridgeMint(address indexed to, uint256 amount, address indexed operator);

    /// @notice Emitted when BURNER_ROLE destroys a balance, recording which operator burned.
    event BridgeBurn(address indexed from, uint256 amount, address indexed operator);

    /// @notice Emitted when the admin sweeps tokens that were sent here by mistake.
    event TokensRescued(address indexed token, address indexed to, uint256 amount);

    error ZeroAddress();
    error ArrayLengthMismatch(uint256 recipients, uint256 amounts);
    error EmptyBatch();

    /**
     * @param name_     Token name, also used as the EIP-712 domain name for `permit`.
     * @param symbol_   Token symbol.
     * @param decimals_ Should match the asset's decimals on the source chain.
     * @param admin     Receives all four roles. Cannot be the zero address.
     */
    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        address admin
    ) ERC20(name_, symbol_) ERC20Permit(name_) {
        if (admin == address(0)) revert ZeroAddress();

        _tokenDecimals = decimals_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
        _grantRole(BURNER_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    /// @inheritdoc ERC20
    function decimals() public view override returns (uint8) {
        return _tokenDecimals;
    }

    /// @notice Mints `amount` to `to`, for an inbound transfer from the source chain.
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
        emit BridgeMint(to, amount, _msgSender());
    }

    /// @notice Mints to many recipients in one transaction, to settle a batch of transfers.
    function mintBatch(
        address[] calldata recipients,
        uint256[] calldata amounts
    ) external onlyRole(MINTER_ROLE) {
        if (recipients.length != amounts.length) {
            revert ArrayLengthMismatch(recipients.length, amounts.length);
        }
        if (recipients.length == 0) revert EmptyBatch();

        for (uint256 i = 0; i < recipients.length; ++i) {
            _mint(recipients[i], amounts[i]);
            emit BridgeMint(recipients[i], amounts[i], _msgSender());
        }
    }

    /**
     * @notice Destroys `amount` from `from` without requiring an allowance.
     * @dev Distinct from the inherited `burn` and `burnFrom`, which stay allowance-based
     *      so holders and their approved spenders keep the standard ERC20 behaviour.
     */
    function adminBurn(address from, uint256 amount) external onlyRole(BURNER_ROLE) {
        _burn(from, amount);
        emit BridgeBurn(from, amount, _msgSender());
    }

    /// @notice Halts every transfer, mint and burn until `unpause` is called.
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Resumes transfers after `pause`.
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    /**
     * @notice Sends tokens held by this contract to `to`.
     * @dev This contract has no reason to hold a balance, so anything here arrived by
     *      mistake. Passing this token's own address is allowed on purpose: users
     *      sending the token to its own contract address is the most common mistake.
     */
    function rescueERC20(
        IERC20 token,
        address to,
        uint256 amount
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (to == address(0)) revert ZeroAddress();

        SafeERC20.safeTransfer(token, to, amount);
        emit TokensRescued(address(token), to, amount);
    }

    /// @dev Resolves the `_update` hook shared by ERC20 and ERC20Pausable.
    function _update(
        address from,
        address to,
        uint256 value
    ) internal override(ERC20, ERC20Pausable) {
        super._update(from, to, value);
    }
}
