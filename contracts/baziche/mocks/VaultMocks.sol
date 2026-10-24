// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

interface IArcadeVault {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

/**
 * Counterparties for test/ArcadeVault.test.ts, and nothing else. None is deployed by
 * ignition/modules/baziche.ts or probed by scripts/preflight.ts.
 *
 * `withdraw` and `withdrawFees` pay with `Address.sendValue`, which forwards all remaining gas,
 * so a contract on the receiving end runs arbitrary code inside the payment. Those are the only
 * two places the vault hands control to someone else, and these are what stand in that spot.
 * The third is a contract wallet, because a stake may be signed through ERC-1271.
 */

/**
 * @dev Deposits, withdraws, then tries to withdraw again from `receive`. Stores the inner
 *      call's failure rather than bubbling it, so a test can prove the guard fired *and* see
 *      that the outer withdrawal still paid exactly once.
 */
contract ReentrantWithdrawer {
    IArcadeVault public immutable vault;

    bool public armed;
    uint256 public amount;

    bool public reenteredCallFailed;
    uint256 public receiveCount;

    constructor(IArcadeVault vault_) {
        vault = vault_;
    }

    function deposit() external payable {
        vault.deposit{value: msg.value}();
    }

    function withdraw(uint256 amount_) external {
        amount = amount_;
        armed = true;

        vault.withdraw(amount_);
    }

    receive() external payable {
        receiveCount += 1;

        if (!armed) {
            return;
        }
        armed = false;

        try vault.withdraw(amount) {
            reenteredCallFailed = false;
        } catch {
            reenteredCallFailed = true;
        }
    }
}

/// @dev Refuses every payment, so a withdrawal to it reverts inside `Address.sendValue`.
contract RejectingReceiver {
    IArcadeVault public immutable vault;

    constructor(IArcadeVault vault_) {
        vault = vault_;
    }

    function deposit() external payable {
        vault.deposit{value: msg.value}();
    }

    function withdraw(uint256 amount) external {
        vault.withdraw(amount);
    }

    receive() external payable {
        revert("no thanks");
    }
}

/**
 * @dev A smart-contract wallet: a stake is valid when its owner's key signed the digest, as
 *      ERC-1271 has it. Deposits and withdraws as itself, the way a real one would.
 */
contract StakeWallet is IERC1271 {
    IArcadeVault public immutable vault;
    address public immutable owner;

    constructor(IArcadeVault vault_, address owner_) {
        vault = vault_;
        owner = owner_;
    }

    function deposit() external payable {
        vault.deposit{value: msg.value}();
    }

    function withdraw(uint256 amount) external {
        require(msg.sender == owner, "not the owner");
        vault.withdraw(amount);
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecover(hash, signature);
        return err == ECDSA.RecoverError.NoError && recovered == owner ? this.isValidSignature.selector : bytes4(0);
    }

    receive() external payable {}
}
