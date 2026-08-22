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

`npm run build` is `compile`, then `node scripts/write-init-code-hash.ts`, then `compile`
again. The second pass is not superstition: the AMM in `contracts/univ2` hardcodes a hash
of its own compiled pair bytecode, so the first compile is what the hash is computed
from and the second is what picks it up. Use `npm run build` rather than
`hardhat compile` after touching anything under `contracts/univ2` — see
[The V2 swap](#the-v2-swap).

## Deploy

Contracts are grouped by folder under `contracts/`, and each folder has one Ignition
module of the same name in `ignition/modules/`. You deploy one group at a time with `--sc`:

```bash
npx hardhat deploy --sc token   --network nurachain   # only contracts/token
npx hardhat deploy --sc airdrop --network nurachain   # only contracts/airdrop
npx hardhat deploy --sc univ2   --network nurachain   # only contracts/univ2
npx hardhat deploy --sc univ3   --network nurachain   # only contracts/univ3
npx hardhat deploy --sc vault   --network nurachain   # only contracts/vault
```

`--sc vault` needs a `--parameters` file for the ERC20 address it locks — see
[The collateralized NFT vault](#the-collateralized-nft-vault).

Or through npm:

```bash
npm run deploy:nurachain:token
npm run deploy:nurachain:airdrop
npm run deploy:nurachain:univ2

# equivalent, passing the flag through npm — note the extra --
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
once deployed, so neither has a default — answer, or re-run with --max-claims
and --reward.

  Maximum number of claims: 50000
  Reward per claim, in NURA: 200

  Cap:    50,000 claims (immutable)
  Reward: 200 NURA per claim
  Pool:   10,000,000 NURA to cover every claim, sent to the
          deployed address afterwards — this module does not fund it.
```

`maxClaims` is `immutable` in the contract — there is no setter, no upgrade, no second
chance — and the two together decide how much coin you are committing to fund. That is
why neither has a default: the wrong number here is not a number you get to change.

Answer at the prompt, or supply them up front and skip the questions:

```bash
npx hardhat deploy --sc airdrop --network nurachain --max-claims 50000 --reward 200
```

`--reward` is in whole coin, not wei. Both are also read from the parameters file
below, and anything found there is not asked about. A run with no terminal to ask on —
CI, a piped shell — fails with that message rather than deploying a guess.

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
  "univ2":   { "feeToSetter": "0xYourMultisig" }
}
```

then pass it:

```bash
npx hardhat deploy --sc airdrop --network nurachain --parameters ./ignition/params.json
```

`maxClaims` and `rewardAmount` there are optional — include them to deploy without
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
npm run deploy:nurachain:univ3
npm run deploy:nurachain:vault -- --parameters ./ignition/params.json

# 3. Fund and verify the vault reserve
npm run setup:nurachain:vault
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

### Verification

Nurachain's explorer is [explorer.nurachain.net](https://explorer.nurachain.net) — its
own software ("Nura Explorer", built on AzerothJS), not Blockscout and not an Etherscan
clone. `hardhat.config.ts` describes it under `chainDescriptors`, keyed by
`NURACHAIN_CHAIN_ID`, in the `blockscout` slot because that is the provider
hardhat-verify drives without an API key — and this explorer has no key to give. That
is also why `ETHERSCAN_API_KEY` is gone: nothing here uses it.

**Automated verification does not work yet, and that is the explorer's side, not
this repo's.** Its `/api` answers in the Etherscan shape but implements only the
`account` module; `module=contract&action=verifysourcecode` comes back
`Error! Missing or unsupported module`, so `npx hardhat verify --network nurachain`
and `deploy --verify` have nothing to talk to. Verified against the live endpoint —
recheck it if Nurachain announces verification support, at which point the config is
already pointed at the right place.

Until then, verify by hand — flatten the source and paste it into the explorer UI:

```bash
npx hardhat flatten contracts/token/BridgeUSDT.sol > flat.sol
```

## The airdrop

`contracts/airdrop/Airdrop.sol` pays a fixed amount of native NURA to the first N
eligible addresses that call `getReward`. One claim per address, ever. The amount and
the cap are chosen at deploy time — see [the prompts above](#the-airdrop-asks-before-it-deploys);
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
every claim needs `maxClaims * rewardAmount` sent to the deployed address — 10,000,000
NURA at 50,000 x 200. The deploy prints that figure once you have answered. It pays out
until the balance runs dry, then reverts with `InsufficientBalance` — so you can start
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
`grantRole(SIGNER_ROLE, newKey)` / `revokeRole(SIGNER_ROLE, oldKey)` — in-flight
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
  gasless claiming, that is a relayer/meta-transaction change — ask and I'll add it.

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

Pairs are not deployed here — the factory creates them on demand the first time someone
adds liquidity for a pair.

### The trading fee is adjustable

Upstream UniswapV2 burns its 0.30% fee into the pair bytecode, where nothing can reach
it. Here the fee is a slot on the factory, starting at **0.25%** (PancakeSwap V2's rate)
and changeable afterwards:

```solidity
factory.swapFee();        // 25, i.e. 0.25%, in hundredths of a percent
factory.MAX_SWAP_FEE();   // 100, i.e. 1.00%
factory.setSwapFee(30);   // 0.30% — feeToSetter only
```

One number covers every pair, and a change lands on the very next swap. Raising it
makes the pairs' K check stricter, so swaps already in the mempool at the old rate
revert rather than underpay — irritating for those traders, never a loss to the pool.
Lowering it only loosens the check, so nothing in flight breaks.

`MAX_SWAP_FEE` is `constant`, baked into the bytecode, and **cannot itself be raised** —
lifting the ceiling means deploying a new factory. It is what stops the fee key from
being a switch that confiscates whole trades.

`feeToSetter` (deploy parameter, defaults to the deployer) is the key for all of it:
`setSwapFee`, `setFeeTo` — which turns on the protocol's 1/6 cut of the trading fee, off
at launch so the whole fee goes to liquidity providers — and `setFeeToSetter`, which
hands those rights to someone else.

### The init code hash, and why the build compiles twice

`UniswapV2Library.pairFor` works out a pair's address by doing the CREATE2 arithmetic
itself instead of asking the factory — that is what makes the router cheap. The
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
`production` profile — the one Ignition deploys with — keeps only the compiler *versions*
from a bare `compilers` list and substitutes its own settings, which would quietly build
the pair at 200 runs on deploy while `npm test` used 999999. Same source, two hashes, and
only the deployed one matters.

`test/UniV2.test.ts` is the guard. Four of its tests go through `pairFor` and fail loudly
if the constant and the compiled pair have drifted apart, so `npm test` catches this
before a deploy does.

### The pair init code hash and the live router disagree, on purpose

`contracts/univ2` was called `contracts/swap` when the AMM now live on Nurachain was
deployed. solc appends a metadata hash covering the **source paths**, so renaming the
folder changed the pair's creation bytecode and therefore the hash `UniswapV2Library`
hardcodes:

```
this tree                       0x206906a00400e28bd97b729a655caa755d56148826639b4504155fa9085859d9
UniswapV2Router02 0xfE12…3850   0xeb2327179f1be839585a8698f717f96b9027cacbe0d66bbcf7d98f9f8c6bb2ef
```

Nothing is broken. A deployed factory and router agree with each other forever, so the
live V2 keeps working exactly as before, and anything built from this tree is equally
self-consistent — they are just two different builds. Two consequences worth knowing:

- The **live** router is reproducible only from `ignition/deployments/chain-1020/build-info`,
  not from the working tree. That is what to flatten if you ever verify it on the explorer.
- `--sc univ2` against Nurachain redeploys nothing: the deployment records were remapped
  from `swap#…` to `univ2#…`, so Ignition sees those futures as already done. A `--reset`,
  or a deploy to another chain, would build the new hash instead.

`contracts/univ3` is immune to all of this — v3-core compiles with
`metadata.bytecodeHash: "none"`, so its bytecode carries no source paths and the pool hash
survived the rename untouched.

### The demo tokens

`contracts/univ2/tokens` holds `NuraToken` (fixed 100M supply) and `MockToken` (mUSDT,
mUSDC, mDAI, mWBTC — with an optional public faucet). They compile and the tests use
them, but the `swap` module does not deploy them: mock assets and an open faucet are
testnet furniture. Ask if you want a group that deploys them.

## The V3 swap

`contracts/univ3` is UniswapV3, vendored verbatim and deployed **alongside** the V2 in
`contracts/univ2` rather than replacing it. Provenance and every local modification are in
[`contracts/univ3/VENDORED.md`](contracts/univ3/VENDORED.md); it is GPL-2.0 and carries its own
[`LICENSE`](contracts/univ3/LICENSE), unlike the GPL-3.0 V2 next to it.

`--sc univ3` deploys seven contracts:

| Contract | What it is |
| --- | --- |
| `UniswapV3Factory` | Creates one pool per (token pair, fee tier), with CREATE2 |
| `NFTDescriptor` | Library, linked into the descriptor below |
| `NonfungibleTokenPositionDescriptor` | Draws the position NFT's on-chain SVG |
| `NonfungiblePositionManager` | Liquidity positions as ERC721 tokens |
| `SwapRouter` | What wallets call: single and multi-hop swaps |
| `QuoterV2` | Quotes, by simulating a swap and reverting with the result |
| `TickLens` | Bulk tick reads, for depth charts |

It **reuses** the WNURA and Multicall3 the `swap` module already deployed — a second
wrapped-native contract would split every native pool in half. Pools are not deployed
here either; `createAndInitializePoolIfNecessary` makes them on demand, the same way V2
pairs appear on the first `addLiquidity`.

### Fee tiers

Concentrated liquidity means an LP picks a price range, so the fee is per pool and
immutable — unlike V2 on this chain, where one factory slot sets the rate for every pair.
The canonical four are enabled:

| Fee | Tick spacing | For |
| --- | --- | --- |
| 0.01% | 1 | stablecoin pairs |
| 0.05% | 10 | correlated, high volume |
| 0.30% | 60 | the default for most pairs |
| 1.00% | 200 | exotic or volatile |

The factory's constructor enables 0.05/0.30/1.00; the module adds 0.01%. `enableFeeAmount`
is **one-way** — a tier can never be removed and its spacing can never be changed — so
the set enabled at launch is the set this chain lives with. Deviating from Uniswap's
pairing would fragment liquidity *and* break every V3 SDK, subgraph and aggregator that
assumes these four.

### 24576 bytes, and why the compiler settings are copied not chosen

Nurachain enforces EIP-170 exactly. Simulating a deploy against the node returns
`max code size exceeded: code size 24577 limit 24576`, and:

```
UniswapV3Factory              24535 bytes    41 spare
NFTDescriptor                 24541 bytes    35 spare
NonfungiblePositionManager    24384 bytes   192 spare
```

`metadata.bytecodeHash: "none"` alone is worth about 40 of those bytes. So the solc 0.7.6
settings in `hardhat.config.ts` — the per-file optimizer runs, the istanbul target, the
metadata flag — are copied from upstream's own configs rather than picked, and changing
any of them can make the factory undeployable. `test/univ3/Build.test.ts` asserts every
contract against the limit and `npm run preflight:nurachain` prints the margin, so this
fails in the test suite rather than on-chain.

The same settings are why our `UniswapV3Pool` hashes to
`0xe34f199b…8b8b54` — **byte-for-byte Uniswap's own published `POOL_INIT_CODE_HASH`**.
`npm run initcodehash` regenerates it from our build for the same reason it regenerates
V2's, and equality with the published constant is a free proof that nothing has drifted.

### The oracle needs a bigger buffer here than on Ethereum

Every pool keeps a ring buffer of observations, **one slot** until someone pays to grow
it. Nurachain's blocks are ~3.02s against Ethereum's ~12s, so the same TWAP window needs
four times the slots:

```
30-minute TWAP    Nurachain ~600 observations    Ethereum ~150
```

`pool.increaseObservationCardinalityNext(600)` costs about 13.4M gas — comfortable inside
the 150M block limit, but not something that happens by accident. Copying mainnet's
cardinality onto this chain would silently give a seven-minute TWAP. And a deep buffer is
capacity, not history: a pool grown a second ago still has a second of history.

**Do not price anything off these TWAPs yet.** The chain currently has one V2 pair holding
dust, so a V3 TWAP here is manipulable for near-zero capital until real liquidity exists.

### Deploying it

```bash
npm run preflight:nurachain      # gas estimates AND the per-contract size check
npm run deploy:nurachain:univ3
```

> **Never pass `--reset`.** Ignition keys a deployment by chain id, so the `v3` module
> writes into the same `ignition/deployments/chain-1020/` folder that holds the **live V2
> addresses**. `--reset` wipes it. The V2 contracts stay deployed; the record of where
> they are does not, and that folder is gitignored. Back it up first.

`UniswapV3Factory` sets `owner` to whoever deploys it, and that key can enable fee tiers
and switch on the protocol's cut of swap fees (up to 1/4). Moving it to a multisig is a
deliberate manual step — `factory.setOwner(multisig)` — for the same reason V2's
`feeToSetter` is: handing away control should not be a side effect of a deploy script.

## The collateralized NFT vault

`contracts/vault/CollateralizedNFT.sol` is an ERC721 where every NFT is a claim on a fixed
amount of an ERC20 the contract holds. Mint an NFT and a slice of the reserve is set aside
for it; redeem the NFT and exactly that slice comes back.

The lifecycle, end to end:

```
2,500,000 tokens deposited      deposit(2_500_000e18)   -> availableBacking 2,500,000
        |                                                  remainingMintCapacity 10,000
        v
mint an NFT                     mint(alice)             -> tokenId 1
        |                                                  lockedAmount[1] = 250e18
        |                                                  totalReserved   = 250e18
        v                                                  capacity        = 9,999
250 tokens reserved for it      the tokens do not move; they are booked, not sent
        |
        v
alice holds, or sells, NFT #1   a transfer carries the lock with it; the amount does not change
        |
        v
the holder redeems              redeem(1)               -> NFT #1 burned
        |                                                  250e18 sent to its owner
        v                                                  lockedAmount[1] deleted
250 tokens returned                                        totalReserved   = 0
```

`10,000` is nowhere in the contract. Capacity is always computed as
`availableBacking() / lockAmount`, so it follows the balance and the configured lock rather
than a constant that could drift out of step with either.

### What it guarantees

Two invariants, both held by construction rather than by a check that could be forgotten:

1. `totalReserved == sum(lockedAmount[id])` over outstanding NFTs. Every write to
   `lockedAmount` moves `totalReserved` by the same amount in the same call.
2. `totalReserved <= backingToken.balanceOf(vault)`. Minting is the only thing that raises
   `totalReserved`, and it first checks the unreserved balance covers it. The only ways out
   are redemption, which lowers both sides equally, and `withdrawExcessTokens`, which is
   bounded by `availableBacking()`.

Together those mean an NFT that exists can always be redeemed for the amount it was minted
with — including after the admin has swept every unreserved token out.

### Per-NFT amounts are frozen at mint

`setLockAmount` decides what the *next* mint reserves. It does not touch any NFT that already
exists:

```
lockAmount = 250e18       NFT #1 -> 250, NFT #2 -> 250
setLockAmount(500e18)
lockAmount = 500e18       NFT #3 -> 500, NFT #4 -> 500

NFT #1 and #2 still redeem for 250 each.
```

Each NFT carries its own number in `lockedAmount[tokenId]` until it is redeemed, so no
configuration change can inflate or deflate what an outstanding position is worth.

### Deploying it

The ERC20 address has no default and cannot have one: it is immutable after construction, and
a wrong value produces a contract that can never pay anybody. Put it in
`ignition/params.json`:

```json
{
  "vault": {
    "token": "0xTheERC20AlreadyDeployedOnNurachain",
    "admin": "0xYourMultisig",
    "lockAmount": "250000000000000000000n",
    "name": "Backed Position",
    "symbol": "BPOS",
    "baseURI": "https://your.api/vault/"
  }
}
```

```bash
npm run preflight:nurachain      # gas estimates and the EIP-170 size check
npx hardhat deploy --sc vault --network nurachain --parameters ./ignition/params.json
npm run setup:nurachain:vault    # funds the reserve, then verifies and prints the state
```

Like the airdrop module, `ignition/modules/vault.ts` deploys and stops — it does not move the
reserve in, because funding needs an allowance from whoever holds the tokens and that is not
always the deploying key. `scripts/vault-setup.ts` is the second half: it finds the deployed
vault in the Ignition journal, reads back the token it is pinned to, scales 2,500,000 by that
token's real `decimals()`, deposits the shortfall, and then checks what it printed:

```
Vault:          0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0
NFT:            Backed Position (BPOS)
Backing token:  0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
                USDT, 18 decimals
Lock per NFT:   250 USDT (250000000000000000000 base units)

Target reserve: 2,500,000 USDT
Held now:       0 USDT

Depositing 2,500,000 USDT...

State
  token balance:          2,500,000 USDT
  total reserved:         0 USDT
  available backing:      2,500,000 USDT
  NFTs minted:            0
  NFTs redeemed:          0
  NFTs outstanding:       0
  lock amount:            250 USDT
  remaining capacity:     10000 NFTs

Verified. 10000 more NFTs can be backed at the current lock amount.
```

Re-running it is the intended way to top up: it deposits the difference between the current
balance and the target and does nothing when the target is already met. `VAULT_RESERVE` sets
a different target in whole tokens, `VAULT_ADDRESS` points it at a contract Ignition did not
deploy, and `VAULT_SKIP_FUNDING=1` makes it report without moving anything. No key ever
appears in it — the signer comes from the network config, as everywhere else.

`lockAmount` is in the token's own decimals. The default of `250e18` assumes 18 of them; on a
6-decimal token, 250 tokens is `250000000`, and passing the 18-decimal default instead would
reserve 250 trillion per NFT and back nothing. The setup script checks the configured amount
against the token's real `decimals()` and says so if it does not divide cleanly.

### Minting is free, so it is gated

This is the part to decide before launch. An NFT is backed *out of the reserve* rather than
paid for, so `mint` followed by `redeem` is a round trip that hands the caller 250 tokens for
nothing but gas. With minting open to everyone, the entire 2,500,000 belongs to whoever asks
first.

So `publicMintEnabled` starts `false` and only `MINTER_ROLE` can mint. That leaves two sane
shapes:

- **Keep it closed.** A backend or a separate contract holds `MINTER_ROLE` and decides who
  gets an NFT — after a payment, a whitelist, a signature, whatever the eligibility rule is.
- **Open it deliberately.** `setPublicMintEnabled(true)` makes the reserve a first-come
  giveaway. That is a real design, but it should be the one you meant.

Nothing in the contract charges for a mint, on purpose: what a mint is worth depends on the
programme, and baking a price into the collateral logic would make the two impossible to
change independently.

### API

| Function                                     | Who              | Does                                                     |
| -------------------------------------------- | ---------------- | -------------------------------------------------------- |
| `deposit(amount)`                            | anyone           | Pulls backing tokens in. A raw `transfer` works too       |
| `mint(recipient)`                            | minter or public | One NFT, reserving the current `lockAmount`               |
| `mintBatch(recipient, quantity)`             | minter or public | `quantity` NFTs, reserving `quantity * lockAmount`        |
| `redeem(tokenId)`                            | the NFT's owner  | Burns it and pays the owner its locked amount             |
| `burn(tokenId)`                              | the NFT's owner  | Alias for `redeem`, refund included                       |
| `setLockAmount(newAmount)`                   | admin            | Sets what future mints reserve. Existing NFTs unaffected  |
| `setPublicMintEnabled(bool)`                 | admin            | Opens minting to everyone, or closes it to `MINTER_ROLE`  |
| `setBaseURI(newBaseURI)`                     | admin            | Metadata prefix; `tokenURI` appends the id                |
| `withdrawExcessTokens(to, amount)`           | admin            | Unreserved tokens only, bounded by `availableBacking()`   |
| `rescueERC20(token, to, amount)`             | admin            | Any token except the backing one                          |

Views: `tokenBalance()`, `availableBacking()`, `remainingMintCapacity()`, `totalSupply()`,
`lockedAmount(tokenId)`, `totalReserved()`, `totalMinted()`, `totalRedeemed()`, and
`vaultState()`, which returns all of it in one call.

### What it deliberately does not have

Each of these would be a way to take collateral from holders, so none is here:

- **No pausing.** A pausable `redeem` is an admin switch for freezing other people's
  collateral. Minting can be stopped instead — revoke `MINTER_ROLE` and turn public minting
  off — which closes the programme without touching anything already issued.
- **No `ERC721Burnable`.** Its `burn` destroys an NFT without releasing the lock, which would
  strand that collateral and break invariant 1 permanently. `redeem` is the only path that
  burns, and it always pays out.
- **No mutable token address.** Repointing it would leave every outstanding NFT claiming a
  token the contract no longer holds.
- **No proxy.** The redemption rule holders are trusting cannot be rewritten under them.
- **No redemption to a third address, and no operator redemption.** `redeem` pays
  `ownerOf(tokenId)` and requires the caller to be that owner. An approval lets someone move
  your NFT, not cash it out.

### Vault caveats

- **Admin and minter keys still matter.** `DEFAULT_ADMIN_ROLE` can change what future NFTs
  are worth, grant `MINTER_ROLE`, open public minting, and sweep unreserved tokens.
  `MINTER_ROLE` reaches the same unreserved balance by a longer route — mint to itself, then
  redeem — because minting is free and redeeming pays out. Neither can touch collateral
  already behind someone else's NFT; that is exactly what the reserve accounting protects,
  and it holds even if both keys are lost or hostile. Everything short of that is real
  power, so multisig both.
- **Non-standard ERC20s.** All transfers go through `SafeERC20`, so tokens that return
  nothing (USDT-style) work and tokens that return `false` revert rather than silently fail.
  Fee-on-transfer tokens are handled on deposit — the event records what actually arrived —
  but a **rebasing** token whose balance shrinks can push the contract below `totalReserved`
  and break solvency. Back this with a plain non-rebasing ERC20.
- **A paused backing token freezes redemptions.** `contracts/token` has `PAUSER_ROLE`; if the
  backing token is one of those, whoever holds that role can stop every payout. Nothing in
  this contract can work around it.
- **Not IERC721Enumerable.** There is no `tokenOfOwnerByIndex` — per-transfer enumeration
  charges every holder gas to serve what an indexer rebuilds from `Transfer` logs for free.
  `totalSupply()` is provided anyway.
- **Not audited.**

## Tests

```bash
npm test              # everything: Mocha suite + Solidity fuzz/invariant suite
npm run test:mocha    # TypeScript suite only, ~1 min
npm run test:solidity # Solidity property + invariant suite only, ~4 min
npm run coverage      # line/branch coverage for the contracts in this repo
npm run typecheck     # tsc --noEmit over config, scripts, modules and tests
```

Narrower slices, for when you are working on one thing:

```bash
npm run test:fuzz      # property tests only (256 randomised runs each)
npm run test:invariant # stateful invariant runs over the vault
npm run test:security  # signature binding, reentrancy, access control, admin bounds
npm run test:scripts   # the deployment layer: input parsing + every Ignition module

npx hardhat test mocha test/Vault.test.ts          # one file
npx hardhat test mocha --grep "protocol fee"       # one describe
npx hardhat test solidity --grep testFuzz_capacity # one property
```

### What runs where

Two runners, because they are good at different things.

| Suite | Files | Covers |
| ----- | ----- | ------ |
| Mocha / TypeScript | `test/**/*.test.ts` | Behaviour, events, revert reasons, access control, signature binding, reentrancy, AMM integration, and the deployment layer |
| Solidity | `contracts/**/test/*.t.sol` | Property tests over arbitrary lock amounts and balances, plus stateful invariant runs against the vault |

The Solidity suite is Hardhat 3's native runner. It needs no Foundry install and no
`forge-std` dependency — cheatcodes are reached through the hevm address directly, and
`targetContracts()` restricts the invariant fuzzer the way `StdInvariant` would.

Three groups are worth knowing about specifically:

- **`test/scripts/params.test.ts`** — the pure functions every deployment input passes
  through, from `scripts/lib/params.ts`. A reward parsed as wei instead of coin is a pool
  short by eighteen orders of magnitude, and a cap parsed loosely is immutable once the
  constructor runs, so they are tested away from any network.
- **`test/scripts/modules.test.ts`** — every Ignition module, actually deployed to the
  in-process chain and inspected. Without these a module could name a contract that no
  longer exists or pass constructor arguments in the wrong order and the whole suite would
  still be green, because everything else deploys with `ethers.deployContract`.
- **`contracts/vault/test/VaultInvariant.t.sol`** — the vault's solvency claims, checked
  against random sequences of every state transition it has rather than against sequences
  someone thought of. The handler holds the admin role, so retuning the lock and sweeping
  unreserved collateral are both in the search space.

### Determinism

Every test runs against Hardhat's in-process chain. Nothing reaches the network, reads a
key, or depends on the clock except through `networkHelpers.time`, which sets block
timestamps explicitly. Fixtures go through `loadFixture`, which snapshots and reverts
rather than re-running setup, so tests cannot leak state into each other.

Two rules worth keeping, both learned from breakage rather than taste:

- **Never build an array of already-invoked contract calls.** `for (const c of [a(), b()])`
  creates every promise up front, so the later rejections sit unhandled until the loop
  reaches them — Node reports an unhandled rejection and kills the run, intermittently.
  Use thunks: `for (const c of [() => a(), () => b()]) await expect(c())...`.
- **Do not chain two async chai matchers.** `.to.emit(...).and.to.changeTokenBalance(...)`
  does not work; capture the transaction and assert against it twice.

### Coverage

```
contracts/token/BridgeToken.sol         100.00% lines   100.00% branches
contracts/airdrop/Airdrop.sol           100.00% lines   100.00% branches
contracts/vault/CollateralizedNFT.sol   100.00% lines   100.00% branches
```

`npm run coverage` is scoped to the contracts in this repo on purpose. Coverage instruments
the bytecode, which changes the `UniswapV2Pair` and `UniswapV3Pool` init code hashes that
`UniswapV2Library` and `PoolAddress` hardcode — so every CREATE2-derived address moves and
the routers compute addresses with no contract at them. Running coverage over the whole
tree fails 85 vendored-AMM tests for that reason alone. It is a property of the technique,
not a broken test: those suites run in full under `npm run test:mocha`.

### CI

`.github/workflows/ci.yml` runs four jobs on push and pull request: build and typecheck,
the Mocha suite, the Solidity suite, and coverage. None of them needs a secret — the
`nurachain` network reads its URL and key through `configVariable()`, which is lazy, so the
config loads without them as long as no job selects that network.

The build job also re-runs `npm run initcodehash` and fails if it changes anything. That is
the guard on the load-bearing constant: the V2 hash is pinned and the script exits non-zero
if the compiled `UniswapV2Pair` stops matching it, and the V3 hash is generated, so drift
shows up as a modified file. Either one means a compiler setting moved, and every pair
address a router computes moves with it.

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
- **EVM target is `cancun`** for the 0.8.28 contracts. OpenZeppelin 5.6 uses the `mcopy`
  opcode, so those cannot target `paris`. The vendored AMM is a separate matter: it is
  pinned to `istanbul` on purpose and must stay there.
- **The AMM's wrapped-native contract is `WNURA`.** Upstream ships it as WETH9 and the
  BNB Chain forks rename it WBNB; here it is renamed once more so wallets show "WNURA"
  for wrapped NURA. It is a name/symbol change to a vendored file and nothing imports
  it — the router reaches it through `IWETH` — so the pair init code hash is unaffected.
  Recorded in [`contracts/univ2/VENDORED.md`](contracts/univ2/VENDORED.md), as the GPL
  requires for a modified file.
- **The AMM is no longer stock UniswapV2, and the fee key is a trust assumption.**
  Whoever holds `feeToSetter` can move the trading fee on every pair at will, up to the
  1% `MAX_SWAP_FEE` ceiling. Traders cannot opt out and get no notice beyond the
  `SwapFeeUpdated` event. That is a real power to hand an EOA — put it behind a multisig,
  and ideally a timelock, before the pools hold meaningful liquidity. The modifications
  are listed in [`contracts/univ2/VENDORED.md`](contracts/univ2/VENDORED.md); they are
  small and tested, but they are changes to code whose audits covered the original.
- **UniswapV2 does not support fee-on-transfer or rebasing tokens** through the plain
  swap functions. The router has `...SupportingFeeOnTransferTokens` variants for the
  first case; rebasing tokens simply break pair accounting.
- **UniswapV3 supports neither, and has no variants at all.** Its pools account by
  balance delta, so a token that moves a different amount than it was told to breaks
  them outright. This is stricter than V2, not looser.
- **The V3 factory owner is a second key with real power.** It can enable fee tiers
  permanently and take up to a quarter of every pool's swap fees. It starts as the
  deployer EOA, same as V2's `feeToSetter`, and both belong behind a multisig before the
  pools hold anything.
- **V3 TWAPs are not safe to price against yet.** The oracle is only as expensive to
  manipulate as the liquidity behind it, and this chain has one V2 pair holding dust.
  See the oracle note under [The V3 swap](#the-oracle-needs-a-bigger-buffer-here-than-on-ethereum).
- **V2 and V3 do not arbitrage themselves.** The same pair can sit at two different
  prices on the two AMMs indefinitely. Anything showing "the price" of a pair is showing
  one venue's price, and a router that quotes one fee for both misprices every trade —
  which is why this repo deploys UniswapV3's own `SwapRouter` rather than the combined
  `SwapRouter02`, whose V2 leg hardcodes the 0.30% that this fork does not charge.
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
contracts/univ3/
  core/**                    vendored UniswapV3 core, solc 0.7.6
  periphery/**               router, position manager, quoter, descriptor, lenses
  vendor/**                  OpenZeppelin 3.4.2 subset, @uniswap/lib, base64-sol
  test/**                    v3-core's own callback harnesses, dev-chain only
  VENDORED.md, LICENSE       upstream versions, the GPL-2.0, and the expired BUSL
contracts/vault/
  CollateralizedNFT.sol      ERC721 backed 1:1 by a reserve of one ERC20
  IBackingToken.sol          IERC20Metadata, so scripts can reach an external token
  mocks/VaultMocks.sol       misbehaving ERC20s and a re-entrant receiver, tests only
  test/VaultFuzz.t.sol       property tests over arbitrary locks and balances
  test/VaultInvariant.t.sol  stateful invariant runs: solvency, conservation, capacity
contracts/airdrop/
  mocks/AirdropMocks.sol     re-entrant and payout-rejecting claimants, tests only
contracts/univ2/
  mocks/UniV2Mocks.sol       flash-swap borrowers, honest and re-entrant, tests only
ignition/modules/
  token.ts                   deploys contracts/token   (--sc token)
  airdrop.ts                 deploys contracts/airdrop (--sc airdrop)
  univ2.ts                   deploys contracts/univ2   (--sc univ2)
  univ3.ts                   deploys contracts/univ3   (--sc univ3)
  vault.ts                   deploys contracts/vault   (--sc vault)
scripts/
  preflight.ts               pre-deploy check: chain id, funding, gas, contract sizes
  write-init-code-hash.ts    regenerates the V3 pool hash, verifies the pinned V2 one
  vault-setup.ts             funds the vault reserve, then verifies and prints its state
  lib/params.ts              deployment input parsing and formatting, shared and tested
test/
  BridgeToken.test.ts        47 tests: roles, mint, burn, pause, permit security, rescue
  Airdrop.test.ts            44 tests: signature binding, replay, reentrancy, caps, admin
  UniV2.test.ts              38 tests: init code hash, swaps, protocol fee, flash swaps
  univ3/Build.test.ts        15 tests: EIP-170 sizes, both init code hashes
  univ3/Factory.test.ts      18 tests: fee tiers, createPool, ownership
  univ3/Pool.test.ts         26 tests: initialize, mint, burn, swap, flash, fees
  univ3/Liquidity.test.ts    15 tests: ranges, tick crossing, fee shares, TickMath
  univ3/Router.test.ts       20 tests: single/multi-hop, slippage, native, quoter
  univ3/Positions.test.ts    20 tests: NFT lifecycle, permit, tokenURI
  univ3/Oracle.test.ts       12 tests: observations, TWAP, cardinality at 3s blocks
  univ3/Coexistence.test.ts   8 tests: V2 and V3 together, and V2 left alone
  Vault.test.ts              88 tests: solvency, redemption, admin bounds, reentrancy
  scripts/params.test.ts     33 tests: deployment input parsing, away from any network
  scripts/modules.test.ts    12 tests: every Ignition module, deployed and inspected
.github/workflows/ci.yml     build, Mocha, Solidity fuzz/invariant, coverage
hardhat.config.ts            five solc versions, networks, and the `deploy --sc` task
```

Each `contracts/<folder>` maps to `ignition/modules/<folder>.ts` and is deployed
independently with `--sc <folder>`.
