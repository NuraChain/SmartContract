// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ArcadeTips} from "../ArcadeTips.sol";

/**
 * A counterparty for test/ArcadeTips.test.ts, and nothing else. It is deployed by no Ignition
 * module and probed by no script.
 *
 * `tip` pays its receiver with `Address.sendValue`, which forwards all remaining gas, so a
 * contract on the receiving end runs arbitrary code inside the payment. That is the one place the
 * contract hands control to somebody else, and this is what stands there: a contract wallet that
 * gives, and that on being given either takes it, refuses it, or gives it on.
 */
contract TipsActor {
    enum Mode {
        Take,
        Refuse,
        PassOn
    }

    ArcadeTips public immutable tips;

    Mode public mode;
    uint256 public receiveCount;
    address public onwardTo;
    bytes32 public onwardId;

    constructor(ArcadeTips tips_) {
        tips = tips_;
    }

    function setMode(Mode mode_) external {
        mode = mode_;
    }

    /// @dev Where `PassOn` sends what it is given, and under which id.
    function passTo(address to, bytes32 id) external {
        onwardTo = to;
        onwardId = id;
    }

    function give(bytes32 id, address to) external payable {
        tips.tip{value: msg.value}(id, to);
    }

    receive() external payable {
        receiveCount += 1;

        if (mode == Mode.Refuse) {
            revert("TipsActor: refused");
        }

        if (mode == Mode.PassOn) {
            tips.tip{value: msg.value}(onwardId, onwardTo);
        }
    }
}
