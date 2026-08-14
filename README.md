# Bridge Tokens — BridgeUSDT & BridgeBNB

Two bridged (wrapped) ERC20 tokens built on OpenZeppelin Contracts 5.x, where the
deployer is the admin and can mint and burn.

| Contract     | Name        | Symbol | Decimals |
| ------------ | ----------- | ------ | -------- |
| `BridgeUSDT` | Bridge USDT | `USDT` | 18       |
| `BridgeBNB`  | Bridge BNB  | `BNB`  | 18       |

Both inherit everything from `contracts/token/BridgeToken.sol`; the child contracts
only fix the name, symbol and decimals.

## What the tokens do

Built from OpenZeppelin `ERC20`, `ERC20Burnable`, `ERC20Pausable`, `ERC20Permit`
and `AccessControl`:

- **Mint** — `mint(to, amount)` and `mintBatch(recipients[], amounts[])`, gated on `MINTER_ROLE`.
- **Burn** — `adminBurn(from, amount)` destroys any account's balance with no allowance, gated on `BURNER_ROLE`.
- **Holder burn** — the standard `burn(amount)` and `burnFrom(owner, amount)` stay allowance-based, so holders can exit the bridge themselves.
- **Pause** — `pause()` / `unpause()` freeze all transfers, mints and burns, gated on `PAUSER_ROLE`.
- **Permit** — EIP-2612 gasless approvals.
- **Rescue** — `rescueERC20(token, to, amount)` sweeps tokens sent to the contract by mistake, gated on `DEFAULT_ADMIN_ROLE`.

### Roles

The address you pass to the constructor receives all four roles at deployment:

| Role                 | Can do                                            |
| -------------------- | ------------------------------------------------- |
| `DEFAULT_ADMIN_ROLE` | Grant/revoke every role, call `rescueERC20`       |
| `MINTER_ROLE`        | `mint`, `mintBatch`                               |
| `BURNER_ROLE`        | `adminBurn` on any account                        |
| `PAUSER_ROLE`        | `pause`, `unpause`                                |

Because roles are separable, you can keep `DEFAULT_ADMIN_ROLE` on your own wallet
and later grant `MINTER_ROLE` / `BURNER_ROLE` to the bridge relayer contract:

```solidity
token.grantRole(token.MINTER_ROLE(), bridgeRelayer);
token.revokeRole(token.MINTER_ROLE(), myOldWallet);
```

## Setup

```bash
npm install
cp .env.example .env    # then fill it in
npm run build
npm test
```

Requires Node 22+. Tested here on Node 24 / Windows.

For a key that controls real value, use the encrypted keystore rather than a
plaintext `.env`:

```bash
npx hardhat keystore set DEPLOYER_PRIVATE_KEY
```

## Deploy

Deployment uses Hardhat Ignition. The admin defaults to the deploying account:

```bash
npm run deploy:testnet    # BSC testnet (chain 97)
npm run deploy:bsc        # BSC mainnet (chain 56)
```

To hand the roles to a multisig instead of the deployer, create
`ignition/params.json`:

```json
{ "BridgeTokens": { "admin": "0xYourMultisigAddress" } }
```

then:

```bash
npx hardhat ignition deploy ignition/modules/BridgeTokens.ts \
  --network bscTestnet --parameters ./ignition/params.json
```

### Verify on BscScan

```bash
npx hardhat verify --network bsc <deployedAddress> <adminAddress>
```

## Deploying to Nurachain

Nurachain is not in any public chain registry, so its RPC URL and chain ID have to
come from Nurachain's own docs and go in your `.env`:

```bash
NURACHAIN_RPC_URL=https://...
NURACHAIN_CHAIN_ID=...
```

The `nurachain` network is already defined in `hardhat.config.ts` and reads both.
Then:

```bash
# 1. Check the RPC, chain id, balance, and that the bytecode runs there
npm run preflight:nurachain

# 2. Deploy both tokens
npm run deploy:nurachain
```

Run the preflight first. It estimates deployment gas against the actual node, which
executes the constructor — so if Nurachain does not support the Cancun opcodes this
build targets, it fails there instead of after you have spent gas on a reverted
deploy. It also refuses to continue if the deployer cannot cover the cost.

**If preflight fails on opcodes**, the fix is to drop to an older OpenZeppelin that
does not use `mcopy` (5.1.x) and set `evmVersion: "paris"` in `hardhat.config.ts`.
Ask and I'll do that downgrade.

**Fund the deployer first** with Nurachain's native gas token — the deployer is
whatever address `DEPLOYER_PRIVATE_KEY` corresponds to, and preflight prints it.

**Verification** depends on what explorer Nurachain runs. If it is Blockscout, add
this to `hardhat.config.ts` and run `npx hardhat verify --network nurachain <address> <admin>`:

```ts
verify: {
  blockscout: { enabled: true },
},
```

If it is an Etherscan-style explorer, it needs its own API key and URL entry instead.
Many small chains support neither, in which case you verify by pasting the flattened
source into their explorer UI — `npx hardhat flatten contracts/token/BridgeUSDT.sol > flat.sol`.

## Notes before you put real value behind this

- **The tokens are only as good as the backing.** Nothing on-chain enforces that
  minted supply matches assets locked on the source chain. A minter can create
  unbacked supply at will. That trust sits entirely with whoever holds `MINTER_ROLE`.
- **`adminBurn` can destroy anyone's balance** and `pause` can freeze the token.
  Those are intentional operator powers, but they are also what an attacker gets if
  your admin key leaks. Move the roles to a multisig — and ideally a timelock — before
  the token holds meaningful value.
- **No replay protection on mints.** If a relayer submits the same source-chain
  deposit twice, it mints twice. Either make the relayer idempotent off-chain, or add
  a `mapping(bytes32 => bool) processed` keyed by source tx hash to `mint`. Ask if you
  want that added.
- **`BridgeUSDT` uses 18 decimals** to match USDT on BNB Chain. USDT on Ethereum and
  Tron uses 6 — bridging from either means the relayer must scale amounts by `1e12`.
- **EVM target is `cancun`.** OpenZeppelin 5.6 uses the `mcopy` opcode, so the build
  cannot target `paris`. BNB Chain supports Cancun; check any other target chain first.
- **Not audited.**

## Layout

```
contracts/token/
  BridgeToken.sol            shared base: roles, mint, burn, pause, permit, rescue
  BridgeUSDT.sol             Bridge USDT / USDT, 18 decimals
  BridgeBNB.sol              Bridge BNB / BNB, 18 decimals
ignition/modules/
  BridgeTokens.ts            deploys both tokens with one admin
test/
  BridgeToken.test.ts        20 tests covering roles, mint, burn, pause, permit, rescue
hardhat.config.ts            solc 0.8.28, optimizer on, BSC + BSC testnet networks
```
