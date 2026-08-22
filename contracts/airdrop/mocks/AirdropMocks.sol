// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IAirdrop {
    function getReward(uint256 deadline, bytes calldata signature) external;
}

/**
 * Counterparties for test/Airdrop.test.ts, and nothing else. Neither is deployed by
 * ignition/modules/airdrop.ts or probed by scripts/preflight.ts.
 *
 * `Airdrop.getReward` pays with `Address.sendValue`, which forwards all remaining gas, so a
 * contract claimant runs arbitrary code inside the claim. That is the one place the airdrop
 * hands control to someone else, and these are what let the tests stand in that spot.
 */

/**
 * @dev Claims, then re-enters `getReward` from `receive`. Stores the inner call's failure
 *      rather than bubbling it, so a test can prove the guard fired *and* see whether the
 *      outer claim still settled.
 */
contract ReentrantClaimer {
    IAirdrop public immutable airdrop;

    bool public armed;
    uint256 public deadline;
    bytes public signature;

    bool public reenteredCallFailed;
    uint256 public receiveCount;

    constructor(IAirdrop airdrop_) {
        airdrop = airdrop_;
    }

    function claim(uint256 deadline_, bytes calldata signature_) external {
        deadline = deadline_;
        signature = signature_;
        armed = true;

        airdrop.getReward(deadline_, signature_);
    }

    receive() external payable {
        receiveCount += 1;

        if (!armed) {
            return;
        }
        armed = false;

        // Swallowed on purpose: bubbling it would revert the outer claim and the test could
        // not tell "the guard blocked re-entry" apart from "the payout itself failed".
        try airdrop.getReward(deadline, signature) {
            reenteredCallFailed = false;
        } catch {
            reenteredCallFailed = true;
        }
    }
}

/// @dev Refuses the payout, so the claim reverts inside `Address.sendValue`.
contract RejectingClaimer {
    IAirdrop public immutable airdrop;

    constructor(IAirdrop airdrop_) {
        airdrop = airdrop_;
    }

    function claim(uint256 deadline_, bytes calldata signature_) external {
        airdrop.getReward(deadline_, signature_);
    }

    receive() external payable {
        revert("no thanks");
    }
}
