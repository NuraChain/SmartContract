// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/**
 * @title IBackingToken
 * @notice The ERC20 that CollateralizedNFT locks behind its NFTs, as seen from the outside.
 *
 * @dev CollateralizedNFT itself only needs `IERC20`, and only ever calls it through SafeERC20,
 *      so this interface exists for tooling rather than for the contract. Hardhat emits
 *      artifacts for `contracts/` alone, so without a file here there is no `IERC20` artifact
 *      to hand `getContractAt` when scripts/vault-setup.ts has to approve and inspect a token
 *      that lives at an address this repo never compiled.
 *
 *      It extends IERC20Metadata rather than IERC20 because `decimals()` is what lets the
 *      setup script scale "2,500,000 tokens" correctly instead of assuming 18, and print
 *      amounts a person can check.
 */
interface IBackingToken is IERC20Metadata {}
