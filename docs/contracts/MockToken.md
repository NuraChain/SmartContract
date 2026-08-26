# MockToken

## Contract Overview

| Property | Value |
| --- | --- |
| Contract name | `MockToken` |
| Solidity file | `contracts/testing/MockToken.sol` |
| Solidity version | `^0.8.20` (compiled with solc 0.8.28) |
| Contract type | Concrete ERC20 dev/test token |
| Purpose | Dev-chain stand-in for real assets (mUSDT/mUSDC/mDAI/mWBTC style); used by the Uniswap V3 test suite and available for local experiments |
| License | MIT |

**Not part of any deploy group** — mock assets are testnet furniture only.

## Inheritance

```text
MockToken
└── ERC20 (OpenZeppelin)
```

## State Variables

| Variable | Type | Visibility | Mutability | Purpose |
| --- | --- | --- | --- | --- |
| `_tokenDecimals` | `uint8` | private | immutable | Configurable decimals returned by overridden `decimals()`. |
| `deployer` | `address` | public | immutable | Sole beneficiary of unbounded `mint`. |
| `faucetEnabled` | `bool` | public | immutable | Whether the public faucet exists at all. Mainnet deployments must pass `false`. |

## Constructor

```solidity
constructor(string name_, string symbol_, uint8 decimals_, bool faucetEnabled_)
    ERC20(name_, symbol_)
```

## Functions

### faucet

```solidity
function faucet(uint256 amount) external;
```

Self-mint up to `100_000 * 10^decimals` per call when `faucetEnabled`. Reverts
`'MockToken: faucet disabled'` / `'MockToken: faucet cap'`. Anyone (when enabled).

### mint

```solidity
function mint(address to, uint256 amount) external;
```

Unbounded mint restricted to `deployer` (`'MockToken: not deployer'`) — liquidity seeding.

Plus full OZ ERC20 surface (`transfer`, `approve`, `transferFrom`, views).

## Security Analysis

Test-only trust model: an enabled faucet means anyone can inflate supply arbitrarily.
Never point real value at a MockToken.

## Deployment Information

Deployed ad hoc by tests (`test/univ3/helpers.ts`). No Ignition module. Addresses: n/a.

## Function Reference

| Function | Visibility | Mutability | Access | Purpose |
| --- | --- | --- | --- | --- |
| `faucet(amount)` | external | nonpayable | Anyone if enabled | Capped self-mint |
| `mint(to,amount)` | external | nonpayable | Deployer | Unbounded seed mint |
| `decimals()` | public | view | Anyone | Configured decimals |
