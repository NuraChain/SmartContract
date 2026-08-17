// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ERC20 } from '@openzeppelin/contracts/token/ERC20/ERC20.sol';

/// @title NURA - the NuraSwap house token. Fixed supply, minted once to the recipient.
contract NuraToken is ERC20 {
    uint256 public constant TOTAL_SUPPLY = 100_000_000e18;

    constructor(address recipient) ERC20('Nura', 'NURA') {
        _mint(recipient, TOTAL_SUPPLY);
    }
}
