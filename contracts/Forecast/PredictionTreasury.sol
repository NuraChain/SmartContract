// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { IPredictionTreasury } from "./interfaces/IPredictionTreasury.sol";
import { ZeroAddress, ZeroAmount, InsufficientLiquidity, TransferFailed } from "./PredictionErrors.sol";
import { FeeCollected, FeeWithdrawn, FeeRecipientChanged } from "./PredictionEvents.sol";

/**
 * @title PredictionTreasury
 * @notice Sink for protocol fees produced by prediction markets. Markets forward their
 *         protocol cut via {depositFee}; the owner withdraws accumulated fees to a
 *         configurable recipient. Two-step ownership guards against a fat-fingered handover,
 *         and withdrawals are reentrancy-guarded native transfers.
 */
contract PredictionTreasury is IPredictionTreasury, Ownable2Step, ReentrancyGuard {
    /// @dev Address that receives {withdraw} transfers.
    address private _feeRecipient;

    /// @dev Running total of all fees collected.
    uint256 private _totalCollected;

    /// @dev Fees collected per originating market.
    mapping(address market => uint256 collected) private _collectedFor;

    /**
     * @param initialOwner Owner allowed to withdraw and re-point the recipient.
     * @param feeRecipient_ Initial address that receives withdrawals.
     */
    constructor(address initialOwner, address feeRecipient_) Ownable(initialOwner) {
        if (feeRecipient_ == address(0)) revert ZeroAddress();
        _feeRecipient = feeRecipient_;
        emit FeeRecipientChanged(feeRecipient_);
    }

    /// @inheritdoc IPredictionTreasury
    function depositFee(address market) external payable {
        if (msg.value == 0) revert ZeroAmount();
        _totalCollected += msg.value;
        _collectedFor[market] += msg.value;
        emit FeeCollected(market, msg.value);
    }

    /**
     * @notice Accepts a bare native transfer as a fee attributed to the sender.
     * @dev Lets a market that only knows how to `call` with value still be recorded.
     */
    receive() external payable {
        _totalCollected += msg.value;
        _collectedFor[msg.sender] += msg.value;
        emit FeeCollected(msg.sender, msg.value);
    }

    /// @inheritdoc IPredictionTreasury
    function withdraw(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (amount > address(this).balance) revert InsufficientLiquidity();
        address to = _feeRecipient;
        (bool ok, ) = payable(to).call{ value: amount }("");
        if (!ok) revert TransferFailed();
        emit FeeWithdrawn(to, amount);
    }

    /// @inheritdoc IPredictionTreasury
    function setFeeRecipient(address recipient) external onlyOwner {
        if (recipient == address(0)) revert ZeroAddress();
        _feeRecipient = recipient;
        emit FeeRecipientChanged(recipient);
    }

    /// @inheritdoc IPredictionTreasury
    function feeRecipient() external view returns (address) {
        return _feeRecipient;
    }

    /// @inheritdoc IPredictionTreasury
    function totalCollected() external view returns (uint256) {
        return _totalCollected;
    }

    /// @inheritdoc IPredictionTreasury
    function collectedFor(address market) external view returns (uint256) {
        return _collectedFor[market];
    }
}
