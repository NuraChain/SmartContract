# Bridge Tokens â€” BridgeUSDT & BridgeBNB

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

- **Mint** â€” `mint(to, amount)` and `mintBatch(recipients[], amounts[])`, gated on `MINTER_ROLE`.
- **Burn** â€” `adminBurn(from, amount)` destroys any account's balance with no allowance, gated on `BURNER_ROLE`.
- **Holder burn** â€” the standard `burn(amount)` and `burnFrom(owner, amount)` stay allowance-based, so holders can exit the bridge themselves.
- **Pause** â€” `pause()` / `unpause()` freeze all transfers, mints and burns, gated on `PAUSER_ROLE`.
- **Permit** â€” EIP-2612 gasless approvals.
- **Rescue** â€” `rescueERC20(token, to, amount)` sweeps tokens sent to the contract by mistake, gated on `DEFAULT_ADMIN_ROLE`.

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

`npm run build` is `compile`, then `node scripts/write-init-code-hash.ts`, then `compile`
again. The second pass is not superstition: the AMM in `contracts/univ2` hardcodes a hash
of its own compiled pair bytecode, so the first compile is what the hash is computed
from and the second is what picks it up. Use `npm run build` rather than
`hardhat compile` after touching anything under `contracts/univ2` â€” see
[The V2 swap](#the-v2-swap).

## Deploy

Contracts are grouped by folder under `contracts/`, and each folder has one Ignition
module of the same name in `ignition/modules/`. You deploy one group at a time with `--sc`:

```bash
npx hardhat deploy --sc token   --network nurachain   # only contracts/token
npx hardhat deploy --sc airdrop --network nurachain   # only contracts/airdrop
npx hardhat deploy --sc univ2    --network nurachain   # only contracts/univ2
```

Or through npm:

```bash
npm run deploy:nurachain:token
npm run deploy:nurachain:airdrop
npm run deploy:nurachain:univ2

# equivalent, passing the flag through npm â€” note the extra --
npm run deploy:nurachain -- --sc token
```

> `npm run deploy:nurachain --sc token` (without the `--`) does **not** work. npm 11
> parses `--sc` as an abbreviation of its own `--scope` config and drops it, so the
> flag never reaches Hardhat. The `--` is what forwards it.

Adding a new group is two steps: create `contracts/<name>/`, add
`ignition/modules/<name>.ts`, then add `"<name>"` to the `DEPLOYABLE` list at the top
of `hardhat.config.ts`. `--sc` validates against that list and errors with the valid
choices if you mistype it.

`--reset` wipes a module's previous deployment state before redeploying:

```bash
npx hardhat deploy --sc airdrop --network nurachain --reset
```

### The airdrop asks before it deploys

`--sc airdrop` has two values it will not guess for you, and stops to ask:

```
contracts/airdrop needs a claim cap and a per-claim reward. The cap is immutable
once deployed, so neither has a default â€” answer, or re-run with --max-claims
and --reward.

  Maximum number of claims: 50000
  Reward per claim, in NURA: 200

  Cap:    50,000 claims (immutable)
  Reward: 200 NURA per claim
  Pool:   10,000,000 NURA to cover every claim, sent to the
          deployed address afterwards â€” this module does not fund it.
```

`maxClaims` is `immutable` in the contract â€” there is no setter, no upgrade, no second
chance â€” and the two together decide how much coin you are committing to fund. That is
why neither has a default: the wrong number here is not a number you get to change.

Answer at the prompt, or supply them up front and skip the questions:

```bash
npx hardhat deploy --sc airdrop --network nurachain --max-claims 50000 --reward 200
```

`--reward` is in whole coin, not wei. Both are also read from the parameters file
below, and anything found there is not asked about. A run with no terminal to ask on â€”
CI, a piped shell â€” fails with that message rather than deploying a guess.

### Deploy parameters

Both modules default the admin to the deploying account. To override, create
`ignition/params.json` (gitignored) keyed by module name:

```json
{
  "token":   { "admin": "0xYourMultisig" },
  "airdrop": {
    "admin":  "0xYourMultisig",
    "signer": "0xYourBackendSignerAddress",
    "maxClaims": "50000n",
    "rewardAmount": "200000000000000000000n"
  },
  "univ2":    { "feeToSetter": "0xYourMultisig" }
}
```

then pass it:

```bash
npx hardhat deploy --sc airdrop --network nurachain --parameters ./ignition/params.json
```

`maxClaims` and `rewardAmount` there are optional â€” include them to deploy without
being asked, leave them out to answer at the prompt. Unlike `--reward`, `rewardAmount`
in this file is in **wei**, in Ignition's `"<digits>n"` spelling for bigints. `--max-claims`
and `--reward` win over the file if you pass both.

## Deploying to Nurachain

Nurachain is the only network this repo targets. `hardhat.config.ts` defines
`nurachain` and the in-process `hardhatMainnet` used by the tests, and nothing else.

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

# 2. Deploy one group at a time
npm run deploy:nurachain:token
npm run deploy:nurachain:airdrop
npm run deploy:nurachain:univ2
```

Run the preflight first. It estimates deployment gas against the actual node, which
executes the constructor â€” so if Nurachain does not support the Cancun opcodes this
build targets, it fails there instead of after you have spent gas on a reverted
deploy. It also refuses to continue if the deployer cannot cover the cost.

**If preflight fails on opcodes**, the fix is to drop to an older OpenZeppelin that
does not use `mcopy` (5.1.x) and set `evmVersion: "paris"` in `hardhat.config.ts`.
Ask and I'll do that downgrade.

**Fund the deployer first** with Nurachain's native gas token â€” the deployer is
whatever address `DEPLOYER_PRIVATE_KEY` corresponds to, and preflight prints it.

### Verification

Nurachain's explorer is [explorer.nurachain.net](https://explorer.nurachain.net) â€” its
own software ("Nura Explorer", built on AzerothJS), not Blockscout and not an Etherscan
clone. `hardhat.config.ts` describes it under `chainDescriptors`, keyed by
`NURACHAIN_CHAIN_ID`, in the `blockscout` slot because that is the provider
hardhat-verify drives without an API key â€” and this explorer has no key to give. That
is also why `ETHERSCAN_API_KEY` is gone: nothing here uses it.

**Automated verification does not work yet, and that is the explorer's side, not
this repo's.** Its `/api` answers in the Etherscan shape but implements only the
`account` module; `module=contract&action=verifysourcecode` comes back
`Error! Missing or unsupported module`, so `npx hardhat verify --network nurachain`
and `deploy --verify` have nothing to talk to. Verified against the live endpoint â€”
recheck it if Nurachain announces verification support, at which point the config is
already pointed at the right place.

Until then, verify by hand â€” flatten the source and paste it into the explorer UI:

```bash
npx hardhat flatten contracts/token/BridgeUSDT.sol > flat.sol
```

## The airdrop

`contracts/airdrop/Airdrop.sol` pays a fixed amount of native NURA to the first N
eligible addresses that call `getReward`. One claim per address, ever. The amount and
the cap are chosen at deploy time â€” see [the prompts above](#the-airdrop-asks-before-it-deploys);
the worked examples below use 200 NURA and 50,000 claims.

Eligibility is proven with an EIP-712 signature from a backend key holding
`SIGNER_ROLE`. That is doing the real work: "one claim per address" on its own is
worthless, because anyone can generate unlimited addresses and take every slot. The
signature is what decides who is eligible; the on-chain checks only stop double claims
and cap overruns.

| Function | Who | What |
| --- | --- | --- |
| `getReward(deadline, signature)` | anyone with a valid signature | Claims `rewardAmount` once |
| `fund()` / plain transfer | anyone | Adds to the payout pool |
| `setRewardAmount(uint256)` | `DEFAULT_ADMIN_ROLE` | Changes the reward for *future* claims |
| `withdraw(to, amount)` | `DEFAULT_ADMIN_ROLE` | Recovers leftover NURA |
| `pause()` / `unpause()` | `PAUSER_ROLE` | Halts claiming |

Views: `remainingClaims()`, `fundedClaims()`, `outstandingLiability()`, `hasClaimed(address)`,
and `claimDigest(account, deadline)` for debugging signatures.

### Funding it

The contract pays from its own native balance, so **deploying is not enough**. Covering
every claim needs `maxClaims * rewardAmount` sent to the deployed address â€” 10,000,000
NURA at 50,000 x 200. The deploy prints that figure once you have answered. It pays out
until the balance runs dry, then reverts with `InsufficientBalance` â€” so you can start
partially funded and top up as you go.

### Backend signing

Your server signs an approval per eligible address. The signing key must hold
`SIGNER_ROLE`:

```ts
import { Wallet } from "ethers";

const signer = new Wallet(process.env.AIRDROP_SIGNER_KEY!);

const domain = {
  name: "Airdrop",
  version: "1",
  chainId: 1020,                  // Nurachain
  verifyingContract: AIRDROP_ADDRESS,
};

const types = {
  Claim: [
    { name: "account", type: "address" },
    { name: "deadline", type: "uint256" },
  ],
};

// deadline is a unix timestamp; the signature is unusable after it
const deadline = BigInt(Math.floor(Date.now() / 1000) + 24 * 3600);
const signature = await signer.signTypedData(domain, types, { account, deadline });

// hand { deadline, signature } to the frontend; the user calls:
//   airdrop.getReward(deadline, signature)
```

The domain binds each signature to this contract on this chain, so one cannot be
replayed against another deployment or a fork. Rotate the key any time with
`grantRole(SIGNER_ROLE, newKey)` / `revokeRole(SIGNER_ROLE, oldKey)` â€” in-flight
signatures from the old key stop working immediately.

### Airdrop caveats

- **The signer key is the whole security model.** Anyone who steals it can sign
  themselves as many claims as the cap allows and drain the entire pool. Keep it off the
  deployer machine, and prefer a separate key from `DEFAULT_ADMIN_ROLE`.
- **`maxClaims` is immutable.** It is set once, in the constructor, from what you answer
  at deploy time. Getting it wrong means redeploying and re-pointing everything at the
  new address.
- **`setRewardAmount` is not retroactive.** Lowering it after 10,000 people claimed
  does not claw anything back.
- **Claimers pay their own gas.** They need a small NURA balance before they can claim,
  which is awkward if the airdrop is meant to be someone's first NURA. If you need
  gasless claiming, that is a relayer/meta-transaction change â€” ask and I'll add it.

## The V2 swap

`contracts/univ2` is UniswapV2, vendored verbatim from the published packages, plus
Multicall3 and two dev-chain tokens. Provenance and the exact upstream versions are in
[`contracts/univ2/VENDORED.md`](contracts/univ2/VENDORED.md); the vendored code is GPL-3.0
and carries its own [`LICENSE`](contracts/univ2/LICENSE), unlike the MIT contracts in the
other two groups.

`--sc univ2` deploys four contracts:

| Contract | What it is |
| --- | --- |
| `WNURA` | Wrapped NURA. The router needs an ERC20 to route native value through |
| `UniswapV2Factory` | Creates one pair contract per token pair, with CREATE2 |
| `UniswapV2Router02` | What wallets call: swaps, add/remove liquidity, native paths |
| `Multicall3` | Read batching at a known address; every UI and indexer expects it |

Pairs are not deployed here â€” the factory creates them on demand the first time someone
adds liquidity for a pair.

### The trading fee is adjustable

Upstream UniswapV2 burns its 0.30% fee into the pair bytecode, where nothing can reach
it. Here the fee is a slot on the factory, starting at **0.25%** (PancakeSwap V2's rate)
and changeable afterwards:

```solidity
factory.swapFee();        // 25, i.e. 0.25%, in hundredths of a percent
factory.MAX_SWAP_FEE();   // 100, i.e. 1.00%
factory.setSwapFee(30);   // 0.30% â€” feeToSetter only
```

One number covers every pair, and a change lands on the very next swap. Raising it
makes the pairs' K check stricter, so swaps already in the mempool at the old rate
revert rather than underpay â€” irritating for those traders, never a loss to the pool.
Lowering it only loosens the check, so nothing in flight breaks.

`MAX_SWAP_FEE` is `constant`, baked into the bytecode, and **cannot itself be raised** â€”
lifting the ceiling means deploying a new factory. It is what stops the fee key from
being a switch that confiscates whole trades.

`feeToSetter` (deploy parameter, defaults to the deployer) is the key for all of it:
`setSwapFee`, `setFeeTo` â€” which turns on the protocol's 1/6 cut of the trading fee, off
at launch so the whole fee goes to liquidity providers â€” and `setFeeToSetter`, which
hands those rights to someone else.

### The init code hash, and why the build compiles twice

`UniswapV2Library.pairFor` works out a pair's address by doing the CREATE2 arithmetic
itself instead of asking the factory â€” that is what makes the router cheap. The
arithmetic needs the keccak256 of the pair's creation bytecode as a **compile-time
constant**, and the value Uniswap ships is the hash of *their* build. Ours differs,
because solc appends a metadata hash covering the source paths and compiler settings and
this repo has its own of both.

Get it wrong and there is no error message worth reading: the router computes an address
with no contract at it, and every swap and every `addLiquidity` reverts somewhere inside
`getReserves`. So the build regenerates the constant:

```bash
npm run build          # compile -> write-init-code-hash -> compile
npm run initcodehash   # just the codegen, if you want to see what it changes
```

Two things in `hardhat.config.ts` are load-bearing for that hash, and both are
commented there: the `999999` optimizer runs with `evmVersion: "istanbul"` on the
0.5.16/0.6.6 compilers, and the fact that both build profiles are spelled out. Hardhat's
`production` profile â€” the one Ignition deploys with â€” keeps only the compiler *versions*
from a bare `compilers` list and substitutes its own settings, which would quietly build
the pair at 200 runs on deploy while `npm test` used 999999. Same source, two hashes, and
only the deployed one matters.

`test/UniV2.test.ts` is the guard. Four of its tests go through `pairFor` and fail loudly
if the constant and the compiled pair have drifted apart, so `npm test` catches this
before a deploy does.

### The demo tokens

`contracts/univ2/tokens` holds `NuraToken` (fixed 100M supply) and `MockToken` (mUSDT,
mUSDC, mDAI, mWBTC â€” with an optional public faucet). They compile and the tests use
them, but the `swap` module does not deploy them: mock assets and an open faucet are
testnet furniture. Ask if you want a group that deploys them.

## Notes before you put real value behind this

- **The tokens are only as good as the backing.** Nothing on-chain enforces that
  minted supply matches assets locked on the source chain. A minter can create
  unbacked supply at will. That trust sits entirely with whoever holds `MINTER_ROLE`.
- **`adminBurn` can destroy anyone's balance** and `pause` can freeze the token.
  Those are intentional operator powers, but they are also what an attacker gets if
  your admin key leaks. Move the roles to a multisig â€” and ideally a timelock â€” before
  the token holds meaningful value.
- **No replay protection on mints.** If a relayer submits the same source-chain
  deposit twice, it mints twice. Either make the relayer idempotent off-chain, or add
  a `mapping(bytes32 => bool) processed` keyed by source tx hash to `mint`. Ask if you
  want that added.
- **`BridgeUSDT` uses 18 decimals** to match USDT on BNB Chain. USDT on Ethereum and
  Tron uses 6 â€” bridging from either means the relayer must scale amounts by `1e12`.
- **EVM target is `cancun`** for the 0.8.28 contracts. OpenZeppelin 5.6 uses the `mcopy`
  opcode, so those cannot target `paris`. The vendored AMM is a separate matter: it is
  pinned to `istanbul` on purpose and must stay there.
- **The AMM's wrapped-native contract is `WNURA`.** Upstream ships it as WETH9 and the
  BNB Chain forks rename it WBNB; here it is renamed once more so wallets show "WNURA"
  for wrapped NURA. It is a name/symbol change to a vendored file and nothing imports
  it â€” the router reaches it through `IWETH` â€” so the pair init code hash is unaffected.
  Recorded in [`contracts/univ2/VENDORED.md`](contracts/univ2/VENDORED.md), as the GPL
  requires for a modified file.
- **The AMM is no longer stock UniswapV2, and the fee key is a trust assumption.**
  Whoever holds `feeToSetter` can move the trading fee on every pair at will, up to the
  1% `MAX_SWAP_FEE` ceiling. Traders cannot opt out and get no notice beyond the
  `SwapFeeUpdated` event. That is a real power to hand an EOA â€” put it behind a multisig,
  and ideally a timelock, before the pools hold meaningful liquidity. The modifications
  are listed in [`contracts/univ2/VENDORED.md`](contracts/univ2/VENDORED.md); they are
  small and tested, but they are changes to code whose audits covered the original.
- **UniswapV2 does not support fee-on-transfer or rebasing tokens** through the plain
  swap functions. The router has `...SupportingFeeOnTransferTokens` variants for the
  first case; rebasing tokens simply break pair accounting.
- **Not audited.**

## Layout

```
contracts/token/
  BridgeToken.sol            shared base: roles, mint, burn, pause, permit, rescue
  BridgeUSDT.sol             Bridge USDT / USDT, 18 decimals
  BridgeBNB.sol              Bridge BNB / BNB, 18 decimals
contracts/airdrop/
  Airdrop.sol                capped native-coin airdrop, EIP-712 signature gated
contracts/univ2/
  core/**                    vendored UniswapV2 core, solc 0.5.16
  periphery/**               vendored UniswapV2 router + WNURA, solc 0.6.6
  tokens/**                  NuraToken and MockToken, dev-chain only
  vendor/Multicall3.sol      read batching for UIs and indexers
  VENDORED.md, LICENSE       upstream versions and the GPL-3.0 they come under
ignition/modules/
  token.ts                   deploys contracts/token   (--sc token)
  airdrop.ts                 deploys contracts/airdrop (--sc airdrop)
  univ2.ts                   deploys contracts/univ2   (--sc univ2)
scripts/
  preflight.ts               pre-deploy check: chain id, funding, real gas estimates
  write-init-code-hash.ts    regenerates the pair hash UniswapV2Library hardcodes
test/
  BridgeToken.test.ts        20 tests: roles, mint, burn, pause, permit, rescue
  Airdrop.test.ts            21 tests: signatures, caps, double claims, funding, admin
  UniV2.test.ts              17 tests: init code hash, liquidity, swaps, native paths
hardhat.config.ts            four solc versions, networks, and the `deploy --sc` task
```

Each `contracts/<folder>` maps to `ignition/modules/<folder>.ts` and is deployed
independently with `--sc <folder>`.
