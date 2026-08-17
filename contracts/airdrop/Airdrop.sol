// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title Airdrop
 * @notice Pays a fixed amount of the native coin to the first `maxClaims` eligible
 *         addresses that call `getReward`. One claim per address, ever.
 *
 * Eligibility is proven with an EIP-712 signature from a backend key holding
 * SIGNER_ROLE. Without that, "one claim per address" would be worthless — anyone can
 * generate unlimited addresses and take every slot. The signature is what actually
 * decides who is eligible; the on-chain checks only stop double claims and overruns.
 *
 * The contract pays out of its own native balance, so it has to be funded before
 * claiming opens: `maxClaims * rewardAmount`. Send the coin directly to the address,
 * or call `fund()`.
 *
 * @dev The signed payload is bound to this contract and this chain through the EIP-712
 *      domain separator, so a signature cannot be replayed against another deployment
 *      or a fork.
 */
contract Airdrop is AccessControl, Pausable, ReentrancyGuard, EIP712 {
    bytes32 public constant SIGNER_ROLE = keccak256("SIGNER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    bytes32 private constant CLAIM_TYPEHASH = keccak256("Claim(address account,uint256 deadline)");

    /// @notice Hard cap on total claims. Immutable — the promise cannot be inflated later.
    uint256 public immutable maxClaims;

    /// @notice Native coin paid per claim.
    uint256 public rewardAmount;

    /// @notice How many claims have been made so far.
    uint256 public totalClaims;

    /// @notice Whether an address has already claimed.
    mapping(address account => bool claimed) public hasClaimed;

    event RewardClaimed(address indexed account, uint256 amount, uint256 claimNumber);
    event RewardAmountUpdated(uint256 previousAmount, uint256 newAmount);
    event Funded(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error AlreadyClaimed(address account);
    error AirdropFull(uint256 maxClaims);
    error SignatureExpired(uint256 deadline);
    error InvalidSignature();
    error InsufficientBalance(uint256 available, uint256 required);

    /**
     * @param admin         Receives DEFAULT_ADMIN_ROLE and PAUSER_ROLE.
     * @param signer        Backend key that signs eligibility. Receives SIGNER_ROLE.
     * @param maxClaims_    Hard cap on claims, e.g. 50_000.
     * @param rewardAmount_ Native coin per claim in wei, e.g. 200 ether for 200 NURA.
     */
    constructor(
        address admin,
        address signer,
        uint256 maxClaims_,
        uint256 rewardAmount_
    ) EIP712("Airdrop", "1") {
        if (admin == address(0) || signer == address(0)) revert ZeroAddress();
        if (maxClaims_ == 0 || rewardAmount_ == 0) revert ZeroAmount();

        maxClaims = maxClaims_;
        rewardAmount = rewardAmount_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
        _grantRole(SIGNER_ROLE, signer);
    }

    /**
     * @notice Claims this address's share of the airdrop.
     * @param deadline  Unix timestamp after which the signature is no longer valid.
     * @param signature EIP-712 signature over Claim(account, deadline) from a SIGNER_ROLE key,
     *                  where `account` must be the caller.
     */
    function getReward(uint256 deadline, bytes calldata signature) external nonReentrant whenNotPaused {
        address account = _msgSender();

        if (block.timestamp > deadline) revert SignatureExpired(deadline);
        if (hasClaimed[account]) revert AlreadyClaimed(account);
        if (totalClaims >= maxClaims) revert AirdropFull(maxClaims);

        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(CLAIM_TYPEHASH, account, deadline)));
        (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecover(digest, signature);
        if (err != ECDSA.RecoverError.NoError || !hasRole(SIGNER_ROLE, recovered)) {
            revert InvalidSignature();
        }

        uint256 amount = rewardAmount;
        if (address(this).balance < amount) {
            revert InsufficientBalance(address(this).balance, amount);
        }

        // Effects before the transfer: the claim is recorded even if the recipient is a
        // contract that tries to re-enter. nonReentrant is the second line of defence.
        hasClaimed[account] = true;
        uint256 claimNumber = ++totalClaims;

        emit RewardClaimed(account, amount, claimNumber);

        Address.sendValue(payable(account), amount);
    }

    /// @notice Claims still available under the cap.
    function remainingClaims() external view returns (uint256) {
        return maxClaims - totalClaims;
    }

    /// @notice How many more claims the current balance can actually pay out.
    function fundedClaims() external view returns (uint256) {
        return address(this).balance / rewardAmount;
    }

    /// @notice Total native coin needed to cover every remaining claim.
    function outstandingLiability() external view returns (uint256) {
        return (maxClaims - totalClaims) * rewardAmount;
    }

    /// @notice The EIP-712 digest a signer must sign for `account`. Useful for backends and tests.
    function claimDigest(address account, uint256 deadline) external view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(CLAIM_TYPEHASH, account, deadline)));
    }

    /**
     * @notice Changes the per-claim reward.
     * @dev Only affects claims made after this call. Addresses that already claimed keep
     *      what they got.
     */
    function setRewardAmount(uint256 newAmount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newAmount == 0) revert ZeroAmount();

        emit RewardAmountUpdated(rewardAmount, newAmount);
        rewardAmount = newAmount;
    }

    /// @notice Halts claiming.
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Resumes claiming.
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    /// @notice Adds native coin to the claim pool.
    function fund() external payable {
        if (msg.value == 0) revert ZeroAmount();
        emit Funded(_msgSender(), msg.value);
    }

    /// @notice Recovers native coin, e.g. what is left once the airdrop closes.
    function withdraw(address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (address(this).balance < amount) {
            revert InsufficientBalance(address(this).balance, amount);
        }

        emit Withdrawn(to, amount);
        Address.sendValue(payable(to), amount);
    }

    /// @notice Accepts plain transfers so the pool can be topped up without calling `fund`.
    receive() external payable {
        emit Funded(_msgSender(), msg.value);
    }
}
