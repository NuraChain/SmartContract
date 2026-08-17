// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ERC20 } from '@openzeppelin/contracts/token/ERC20/ERC20.sol';

/// @title Dev-chain stand-in for a real asset (mUSDT, mUSDC, mDAI, mWBTC).
/// @notice The public faucet only exists where `faucetEnabled` was set at deploy
///         time (local chain, testnet). Mainnet deployments never enable it.
contract MockToken is ERC20 {
    uint8 private immutable _tokenDecimals;
    address public immutable deployer;
    bool public immutable faucetEnabled;

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        bool faucetEnabled_
    ) ERC20(name_, symbol_) {
        _tokenDecimals = decimals_;
        deployer = msg.sender;
        faucetEnabled = faucetEnabled_;
    }

    function decimals() public view override returns (uint8) {
        return _tokenDecimals;
    }

    /// @notice Anyone can mint themselves a capped amount for testing.
    function faucet(uint256 amount) external {
        require(faucetEnabled, 'MockToken: faucet disabled');
        require(amount <= 100_000 * 10 ** _tokenDecimals, 'MockToken: faucet cap');
        _mint(msg.sender, amount);
    }

    /// @notice Unbounded mint for the deployer only - liquidity seeding.
    function mint(address to, uint256 amount) external {
        require(msg.sender == deployer, 'MockToken: not deployer');
        _mint(to, amount);
    }
}
