// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

import {CollateralizedNFT} from "../CollateralizedNFT.sol";

/**
 * Counterparties for test/Vault.test.ts, and nothing else. None of these is deployed by
 * ignition/modules/vault.ts or probed by scripts/preflight.ts.
 *
 * The happy path is tested against the real contracts/token BridgeUSDT rather than a mock,
 * so what lives here is only the badly behaved ends of the ERC20 and ERC721 specs that a
 * well-behaved token cannot exercise.
 */

/**
 * @dev ERC20 with two switches for the awkward cases: `failTransfers` returns false instead
 *      of moving anything, which is what SafeERC20 exists to catch, and `feeBps` skims a cut
 *      so the recipient receives less than the sender sent.
 */
contract MockConfigurableERC20 is ERC20 {
    address private constant FEE_SINK = address(0xFEE);

    bool public failTransfers;
    uint256 public feeBps;

    constructor() ERC20("Configurable", "CFG") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setFailTransfers(bool value) external {
        failTransfers = value;
    }

    function setFeeBps(uint256 value) external {
        feeBps = value;
    }

    /// @dev Returns false rather than reverting, the failure mode a bare `transfer` call misses.
    function transfer(address to, uint256 value) public override returns (bool) {
        if (failTransfers) return false;
        return super.transfer(to, value);
    }

    /// @dev Same, for the pull side used by `deposit`.
    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        if (failTransfers) return false;
        return super.transferFrom(from, to, value);
    }

    /// @dev Skims `feeBps` off transfers between accounts, leaving mints and burns whole.
    function _update(address from, address to, uint256 value) internal override {
        uint256 fee = (from == address(0) || to == address(0) || feeBps == 0)
            ? 0
            : (value * feeBps) / 10_000;

        if (fee > 0) {
            super._update(from, FEE_SINK, fee);
        }
        super._update(from, to, value - fee);
    }
}

/**
 * @dev ERC20 that calls back into the vault while the vault is paying out. Models a token with
 *      a transfer hook, which is the one place `redeem` hands control to code it does not
 *      control. `attack` has to be armed explicitly so funding the vault does not trigger it.
 */
contract MockReentrantERC20 is ERC20 {
    CollateralizedNFT public vault;
    uint256 public targetTokenId;
    bool public attack;

    constructor() ERC20("Reentrant", "RE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(CollateralizedNFT vault_, uint256 tokenId) external {
        vault = vault_;
        targetTokenId = tokenId;
        attack = true;
    }

    /// @dev Fires on the way out of `_redeem`, the moment the vault transfers the refund.
    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);

        if (attack && from == address(vault)) {
            vault.redeem(targetTokenId);
        }
    }
}

/**
 * @dev ERC721 recipient that re-enters from `onERC721Received`, the callback `_safeMint` makes
 *      before `mint` has returned. Accepts the token when disarmed so it can hold NFTs normally.
 */
contract MockReentrantReceiver is IERC721Receiver {
    CollateralizedNFT public immutable vault;

    bool public attackMint;
    uint256 public attackRedeemTokenId;

    constructor(CollateralizedNFT vault_) {
        vault = vault_;
    }

    function armMint() external {
        attackMint = true;
    }

    function armRedeem(uint256 tokenId) external {
        attackRedeemTokenId = tokenId;
    }

    /// @notice Lets the test drive a normal mint to this contract, as a plain holder would receive.
    function mintTo(address recipient) external returns (uint256) {
        return vault.mint(recipient);
    }

    /// @notice Lets the test redeem an NFT this contract legitimately holds.
    function redeem(uint256 tokenId) external {
        vault.redeem(tokenId);
    }

    function onERC721Received(
        address,
        address,
        uint256,
        bytes calldata
    ) external override returns (bytes4) {
        if (attackMint) {
            vault.mint(address(this));
        }
        if (attackRedeemTokenId != 0) {
            vault.redeem(attackRedeemTokenId);
        }

        return this.onERC721Received.selector;
    }
}
