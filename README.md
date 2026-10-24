# Bridge Tokens — BridgeUSDT, BridgeBNB, BridgeETH & BridgeBTC

Four bridged (wrapped) ERC20 tokens built on OpenZeppelin Contracts 5.x, where the
deployer is the admin and can mint and burn.

| Contract     | Name        | Symbol | Decimals |
| ------------ | ----------- | ------ | -------- |
| `BridgeUSDT` | Bridge USDT | `USDT` | 18       |
| `BridgeBNB`  | Bridge BNB  | `BNB`  | 18       |
| `BridgeETH`  | Bridge ETH  | `ETH`  | 18       |
| `BridgeBTC`  | Bridge BTC  | `BTC`  | 18       |

All four inherit everything from `contracts/token/BridgeToken.sol`; the child contracts
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
again. The second pass is not superstition: the AMM in `contracts/univ3` hardcodes a hash
of its own compiled pool bytecode, so the first compile is what the hash is computed
from and the second is what picks it up. Use `npm run build` rather than
`hardhat compile` after touching anything under `contracts/univ3` — see
[The V3 swap](#the-v3-swap).

## Deploy

Contracts are grouped by folder under `contracts/`, and each folder has one Ignition
module of the same name in `ignition/modules/`. The exceptions are `wnura`, which
deploys `contracts/token/WNURA.sol` on its own, and `univ3periphery`, which redeploys
part of `contracts/univ3`. You deploy one group at a time with `--sc`:

```bash
npx hardhat deploy --sc token    --network nurachain   # only contracts/token (bridge tokens)
npx hardhat deploy --sc wnura    --network nurachain   # only contracts/token/WNURA.sol
npx hardhat deploy --sc airdrop  --network nurachain   # only contracts/airdrop
npx hardhat deploy --sc univ3    --network nurachain   # only contracts/univ3
npx hardhat deploy --sc univ3periphery --network nurachain --parameters <file>  # see The V3 swap
npx hardhat deploy --sc forecast --network nurachain   # only contracts/forecast
npx hardhat deploy --sc profile  --network nurachain   # only contracts/profile
npx hardhat deploy --sc baziche  --network nurachain   # only contracts/baziche
```

`--sc wnura` deploys a **new, separate** WNURA. Nurachain already has the canonical one at
`0xf0a4eC07916feBa4432121Ed5969887D9b939cD0`, and `univ3` uses that one unless you pass
`{ "univ3": { "wnura": "0x..." } }` in `--parameters`.

Or through npm:

```bash
npm run deploy:nurachain:token
npm run deploy:nurachain:wnura
npm run deploy:nurachain:airdrop
npm run deploy:nurachain:univ3
npm run deploy:nurachain:univ3periphery
npm run deploy:nurachain:forecast
npm run deploy:nurachain:profile
npm run deploy:nurachain:baziche

# equivalent, passing the flag through npm — note the extra --
npm run deploy:nurachain -- --sc token
```

> `npm run deploy:nurachain --sc token` (without the `--`) does **not** work. npm 11
> parses `--sc` as an abbreviation of its own `--scope` config and drops it, so the
> flag never reaches Hardhat. The `--` is what forwards it.

Adding a new group is three steps: create `contracts/<name>/`, add
`ignition/modules/<name>.ts`, then add `"<name>"` to the `DEPLOYABLE` list at the top
of `hardhat.config.ts`. `--sc` validates against that list and errors with the valid
choices if you mistype it.

`--reset` wipes the previous deployment state before redeploying. That state is kept
per deployment id (`ignition/deployments/chain-<chainId>/` by default), **not** per group,
so `--reset` also forgets the addresses of every other group deployed to that chain.
To redeploy one group from scratch, give it its own folder instead:

```bash
npx hardhat deploy --sc airdrop --network nurachain --deployment-id airdrop-v2
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
  }
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
npm run deploy:nurachain:wnura
npm run deploy:nurachain:airdrop
npm run deploy:nurachain:univ3
npm run deploy:nurachain:univ3periphery
npm run deploy:nurachain:forecast
npm run deploy:nurachain:profile
npm run deploy:nurachain:baziche

# 3. Register the profile registry's verifier extension and print its state
npm run setup:nurachain:profile
```

Run the preflight first. It estimates deployment gas against the actual node, which
executes the constructor — so if Nurachain does not support the Cancun opcodes this
build targets, it fails there instead of after you have spent gas on a reverted
deploy. It also refuses to continue if the deployer cannot cover the cost.

For Arcade's paid tables it measures what the vault will ask of the chain once it is
live: the block time over the last hundred blocks and how old the newest one is, the gas
price the Arcade referee will pay (never under 47 gwei), what one nine-seat game costs it
to lock and pay, and whether the node takes an `open` and a `settle` at two, three, four,
six and nine seats. Those are the largest requests the referee sends, a nine-seat `open`
being about 3 KB of calldata, and Nurachain's rpc once dropped request bodies over about
1.2 KB. A size the node refuses stops the preflight, because the referee could not lock or
pay a game that large there.

**If preflight fails on opcodes**, the fix is to drop to an older OpenZeppelin that
does not use `mcopy` (5.1.x) and set `evmVersion: "paris"` in `hardhat.config.ts`.
Ask and I'll do that downgrade.

**Fund the deployer first** with Nurachain's native gas token — the deployer is
whatever address `DEPLOYER_PRIVATE_KEY` corresponds to, and preflight prints it.

**Deploying from a seed phrase** instead of a private key: set `DEPLOYER_MNEMONIC`
(quoted, space-separated words) in `.env`. It takes precedence over
`DEPLOYER_PRIVATE_KEY`. The deployer is the account at
`m/44'/60'/0'/0/<DEPLOYER_MNEMONIC_INDEX>`, which defaults to index 0, the same address as
MetaMask's first account. Set `DEPLOYER_MNEMONIC_PASSPHRASE` only if the wallet uses a
BIP-39 passphrase. Run preflight to confirm the derived address before funding it.

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

## The V3 swap

`contracts/univ3` is UniswapV3, vendored verbatim — the only AMM in this repo. Provenance
and every local modification are in
[`contracts/univ3/VENDORED.md`](contracts/univ3/VENDORED.md); it is GPL-2.0 and carries its own
[`LICENSE`](contracts/univ3/LICENSE), unlike the MIT contracts elsewhere here.

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

It **reuses** the WNURA and Multicall3 already live on Nurachain from the earlier AMM
deployment — a second wrapped-native contract would split every native pool in half.
(`--sc wnura` can deploy one, but `univ3` only uses it if you pass its address as the
`wnura` parameter.)
Pools are not deployed here either; `createAndInitializePoolIfNecessary` makes them on
demand, the way pairs appear on the first `addLiquidity` anywhere else.

### Fee tiers

Concentrated liquidity means an LP picks a price range, so the fee is fixed per pool and
immutable. The canonical four are enabled:

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
`npm run initcodehash` regenerates it from our build, and equality with the published
constant is a free proof that nothing has drifted.

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

**Do not price anything off these TWAPs yet.** The chain's pools are shallow, so a V3
TWAP here is manipulable for near-zero capital until real liquidity exists.

### Deploying it

```bash
npm run preflight:nurachain      # gas estimates AND the per-contract size check
npm run deploy:nurachain:univ3
```

> **Never pass `--reset`.** Ignition keys a deployment by chain id, so the `v3` module
> writes into the same `ignition/deployments/chain-1020/` folder that holds the **live
> addresses of everything deployed before it** (WNURA, Multicall3, the bridge tokens).
> `--reset` wipes that record; the contracts stay deployed but nothing in the repo knows
> where they are any more, and the folder is gitignored. Back it up first.

`UniswapV3Factory` sets `owner` to whoever deploys it, and that key can enable fee tiers
and switch on the protocol's cut of swap fees (up to 1/4). Moving it to a multisig is a
deliberate manual step — `factory.setOwner(multisig)`: handing away control should not be
a side effect of a deploy script.

### Switching the periphery to a new WNURA

WNURA is immutable in `NonfungibleTokenPositionDescriptor`, `NonfungiblePositionManager`,
`SwapRouter` and `QuoterV2`, so pointing V3 at a different wrapped coin means redeploying
those four. `--sc univ3periphery` does exactly that, against the **existing** factory and
`NFTDescriptor` library; the factory, its pools and `TickLens` are reused untouched.

```bash
npm run deploy:nurachain:univ3periphery
```

The npm script passes `ignition/parameters/univ3periphery.nurachain.json`, which holds the
live factory, library and new WNURA addresses. The module has no defaults for them, so it
refuses to deploy without that file. The factory must be built from the same
`UniswapV3Pool` bytecode as this checkout, since the router and position manager derive
pool addresses from `POOL_INIT_CODE_HASH`.

After switching:

- existing positions stay NFTs in the old position manager and are managed there;
- pools paired with the old WNURA are different pools from new-WNURA pools, so native
  liquidity does not carry over;
- frontends and SDK configs must move to the four new addresses.

## The profile registry

`contracts/profile` is a decentralized, extensible identity primitive: one profile per
address, a globally unique case-normalized username, localizable key/value fields, unlimited
websites / images / socials (and any item kind an application invents), owner-approved
operators, two-step transfer with a recovery address, and a curated registry of extension
contracts that attest data into their own namespace on a profile. It is UUPS-upgradeable
behind an ERC-1967 proxy, keeps its state in one ERC-7201 namespace, and compiles with
`viaIR` so it fits Nurachain's exact EIP-170 limit with room for future versions.

The design rule everything follows from: **the core stores no schema.** Every value is
addressed by `(profile, key, language)`; every list item is a bag of such values under a
free-form `kind`. Adding a field, a language, a platform or a whole "wallets" section is a
transaction, not a redeploy. New *logic* (verification, reputation, achievements) is a
sidecar extension the core never calls into.

```solidity
uint256 id = profile.createProfile("alice", "Alice Doe", "Builder", "ipfs://…avatar");
profile.setLocalizedField(id, "bio", "fa", "توسعه‌دهنده بلاکچین و سازنده Nura Chain");
profile.addWebsite(id, "https://nurachain.net", "Nura Chain");
profile.addSocial(id, "farcaster", "alice", "https://warpcast.com/alice");
profile.addItem(id, "wallet", [FieldInput("chain", "", "bitcoin"), FieldInput("address", "", "bc1q…")]);

lens.getFullProfile(aliceAddress, "fa");   // everything above, resolved in Persian with fallback
```

Three addresses matter: the **proxy** (`NuraProfileProxy`, writes + primitive reads, ABI
`NuraProfile`), the **lens** (`NuraProfileLens`, `getProfile(address, lang)`, `getFullProfile`,
typed and paged collection getters — stateless and replaceable), and the reference
**`SocialVerifier`** extension (EIP-712-attested "this profile owns handle X on platform Y").
The contract admin can upgrade, curate extensions and reserve usernames — and has no path to
any user's content; the test suite asserts that function by function.

Deploy with `npm run deploy:nurachain:profile`, then `npm run setup:nurachain:profile` to
register the verifier; upgrade with `npm run upgrade:nurachain:profile`. The full design
rationale, data model, gas table, security review and frontend integration guide are in
[`contracts/profile/README.md`](contracts/profile/README.md); the per-function reference is
[`docs/contracts/NuraProfile.md`](docs/contracts/NuraProfile.md).

## The arcade vault

`contracts/baziche/ArcadeVault.sol` holds the native NURA that Arcade's players stake on paid
tables. A player deposits once and withdraws what is free whenever they like; playing costs
them no transaction. For each paid game they sign an EIP-712 `Stake`, and the Arcade server,
holding `REFEREE_ROLE`, opens the game with every player's signature and pays it when the game
ends: the pot less the fee to the winners, evenly, with whatever the split leaves joining the
fee.

```solidity
// a player
vault.deposit{value: 100 ether}();
vault.withdraw(40 ether);

// the Arcade server, with every player's signed Stake
vault.open(id, "ludo", 10 ether, 500, seats);       // locks 10 NURA of each, all or nothing
vault.settle(id, 0b0101, secrets);                   // seats 0 and 2 split the pot, less 5%
vault.refund(id);                                    // or every stake back, no fee

// anybody, three days after a game opened and was never paid
vault.reclaim(id);
```

| Function | Who | What |
| --- | --- | --- |
| `deposit()` / plain transfer | anybody | credits the sender's free balance |
| `withdraw(amount)` | the balance's owner | pays them from what is free; never paused |
| `cancel(nonce)` | a player | spends a stake they signed, before it is used |
| `open(id, game, amount, feeBps, seats)` | `REFEREE_ROLE` | locks one game: every signature valid, unexpired and unused, every balance enough, the fee the game's `feeOf` |
| `settle(id, winners, secrets)` | `REFEREE_ROLE` | pays one game; every secret must open the commit its player signed |
| `refund(id)` | `REFEREE_ROLE` | every stake back, no fee |
| `reclaim(id)` | anybody | every stake back, from `reclaimAfter` after the game opened |
| `setFee` / `setGameFee` / `setMaxStake` / `withdrawFees` | `DEFAULT_ADMIN_ROLE` | the fee (1% to 15%, shared or per game) and the ceiling for games not yet opened; the fees taken |
| `setReferee(next)` | `DEFAULT_ADMIN_ROLE` | moves `REFEREE_ROLE` from the current referee to `next` in one call |
| `beginDefaultAdminTransfer(next)` / `acceptDefaultAdminTransfer()` | the owner, then `next` | hands the vault and its pauser role to a new owner; `cancelDefaultAdminTransfer()` takes the naming back |
| `pause()` / `unpause()` | `PAUSER_ROLE` | stops deposits and new games, nothing else |

The referee is trusted to say who won, because the games are played on Arcade's server, and
the contract bounds the rest: it can lock only stakes their players signed, each once and
before its deadline (never more than a day out), at the amount and fee they signed, and pay a
pot only to that game's players, with the secrets that open their commits. It cannot touch a
free balance or stop a withdrawal, and if it never pays a game anybody can reclaim it. The
commits are what make a paid game's dice and cards checkable afterwards: the secrets `settle`
reveals, with the players' signatures from `open`, give the seed the game was drawn from.

It is not upgradeable. Deploy with `npm run deploy:nurachain:baziche` and the `baziche`
parameters (`referee`, `fee`, `maxStake`, `reclaimAfter`; see `ignition/modules/baziche.ts`).
The per-function reference, roles, flows and security analysis are in
[`docs/contracts/ArcadeVault.md`](docs/contracts/ArcadeVault.md).

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
npm run test:invariant # stateful invariant runs over the profile registry and the arcade vault
npm run test:profile   # the profile registry, its lens, its extension and its upgrade path
npm run gas:profile    # gas table for every profile operation
npm run test:security  # signature binding, reentrancy, access control, admin bounds
npm run test:scripts   # the deployment layer: input parsing + every Ignition module

npx hardhat test mocha test/Airdrop.test.ts        # one file
npx hardhat test mocha --grep "protocol fee"       # one describe
npx hardhat test solidity --grep testFuzz_capacity # one property
```

### What runs where

Two runners, because they are good at different things.

| Suite | Files | Covers |
| ----- | ----- | ------ |
| Mocha / TypeScript | `test/**/*.test.ts` | Behaviour, events, revert reasons, access control, signature binding, reentrancy, AMM integration, and the deployment layer |
| Solidity | `contracts/**/test/*.t.sol` | Property tests over the profile registry's inputs, plus stateful invariant runs against its item lists |

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
- **`test/Profile.test.ts`** — the profile registry from every caller's point of view, plus an
  upgrade to a V2 mock that must keep every profile intact, and an "indexer" that replays the
  event stream and diffs the result against the lens. `contracts/profile/test/*.t.sol` adds the
  properties (any two username spellings that fold to the same bytes collide; any value up to
  the cap round-trips) and the item-list invariants under random adds, removes and transfers.

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
contracts/profile/NuraProfile.sol       100.00% lines   100.00% statements
contracts/profile/NuraProfileLens.sol   100.00% lines   100.00% statements
contracts/profile/libraries/ProfileStrings.sol   100.00% lines   100.00% statements
contracts/profile/extensions/SocialVerifier.sol  100.00% lines   100.00% statements
contracts/baziche/ArcadeVault.sol       100.00% lines   100.00% statements
```

`npm run coverage` is scoped to the contracts in this repo on purpose. Coverage instruments
the bytecode, which changes the `UniswapV3Pool` init code hash that
`PoolAddress` hardcodes — so every CREATE2-derived address moves and
the router computes addresses with no contract at them. Running coverage over the whole
tree fails the vendored-AMM tests for that reason alone. It is a property of the technique,
not a broken test: those suites run in full under `npm run test:mocha`.

### CI

`.github/workflows/ci.yml` runs four jobs on push and pull request: build and typecheck,
the Mocha suite, the Solidity suite, and coverage. None of them needs a secret — the
`nurachain` network reads its URL and key through `configVariable()`, which is lazy, so the
config loads without them as long as no job selects that network.

The build job also re-runs `npm run initcodehash` and fails if it changes anything. That is
the guard on the load-bearing constant: the pool init code hash is generated, so drift shows
up as a modified file. A change means a compiler setting moved, and every pool address a
router computes moves with it.

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
- **`BridgeBTC` uses 18 decimals** to match BTCB on BNB Chain. Native Bitcoin and WBTC
  use 8 — bridging from either means the relayer must scale amounts by `1e10`.
- **EVM target is `cancun`** for the 0.8.28 contracts. OpenZeppelin 5.6 uses the `mcopy`
  opcode, so those cannot target `paris`. The vendored AMM is a separate matter: it is
  pinned to `istanbul` on purpose and must stay there.
- **UniswapV3 supports neither fee-on-transfer nor rebasing tokens, and has no variants.**
  Its pools account by balance delta, so a token that moves a different amount than it was
  told to breaks them outright.
- **The V3 factory owner is a key with real power.** It can enable fee tiers permanently
  and take up to a quarter of every pool's swap fees. It starts as the deployer EOA and
  belongs behind a multisig before the pools hold anything.
- **V3 TWAPs are not safe to price against yet.** The oracle is only as expensive to
  manipulate as the liquidity behind it, and this chain's pools are shallow.
  See the oracle note under [The V3 swap](#the-oracle-needs-a-bigger-buffer-here-than-on-ethereum).
- **The profile registry's owner key can upgrade it.** UUPS means whoever holds the
  `NuraProfile` owner can replace the implementation. Ownership is two-step and the owner has
  no path to user content, but an upgrade can add one. Move it to a multisig before users
  depend on it, and treat `upgradeToAndCall` as the most sensitive call in this repo.
- **The arcade vault's referee says who won.** Its key lives on the Arcade server. The
  contract keeps it to stakes players signed and to the players of each game, but whoever
  holds it can pay a locked pot to the wrong player among those seated. Revoking
  `REFEREE_ROLE` stops it at once, and an unpaid game can be reclaimed after the delay. The
  vault's admin can grant itself that role, so the admin belongs behind a multisig before the
  vault holds real value.
- **Playing for money is regulated or banned in many places.** The vault is the mechanism, not
  a licence; check where the product is offered before the vault holds real value.
- **Not audited.**

## Layout

```
contracts/token/
  BridgeToken.sol            shared base: roles, mint, burn, pause, permit, rescue
  BridgeUSDT.sol             Bridge USDT / USDT, 18 decimals
  BridgeBNB.sol              Bridge BNB / BNB, 18 decimals
  BridgeETH.sol              Bridge ETH / ETH, 18 decimals
  BridgeBTC.sol              Bridge BTC / BTC, 18 decimals
  WNURA.sol                  wrapped native coin (Dapphub WETH9, renamed); already live
                             on Nurachain, deployed separately by --sc wnura
contracts/airdrop/
  Airdrop.sol                capped native-coin airdrop, EIP-712 signature gated
contracts/univ3/
  core/**                    vendored UniswapV3 core, solc 0.7.6
  periphery/**               router, position manager, quoter, descriptor, lenses
  vendor/**                  OpenZeppelin 3.4.2 subset, @uniswap/lib, base64-sol
  test/**                    v3-core's own callback harnesses, dev-chain only
  VENDORED.md, LICENSE       upstream versions, the GPL-2.0, and the expired BUSL
contracts/mocks/
  MockToken.sol              dev-chain stand-in asset with optional faucet, tests only
contracts/airdrop/
  mocks/AirdropMocks.sol     re-entrant and payout-rejecting claimants, tests only
contracts/baziche/
  ArcadeAchievements.sol     ERC-1155 achievements, backend-minted; per-id metadata URI, soulbound or tradeable per id
  ArcadeVault.sol            native-coin stakes for Arcade's paid tables: signed stakes, referee-paid pots, reclaim
  mocks/VaultMocks.sol       re-entrant and refusing receivers, an ERC-1271 wallet, tests only
  test/VaultFuzz.t.sol       properties over stakes, fees, seat counts and winners
  test/VaultInvariant.t.sol  the vault holds every wei it owes under random sequences
contracts/profile/
  NuraProfile.sol            UUPS profile registry: usernames, localized fields, items, extensions
  NuraProfileProxy.sol       the ERC-1967 proxy — the address everyone uses
  NuraProfileLens.sol        stateless read model: getProfile, getFullProfile, typed/paged getters
  ProfileTypes.sol           shared structs; ProfileErrors.sol: file-level custom errors
  interfaces/                INuraProfile (full surface + events), IProfileExtension (handshake)
  libraries/                 ProfileKeys (well-known keys/kinds), ProfileStrings (validation, packing)
  extensions/SocialVerifier.sol   reference extension: EIP-712-attested platform handles
  mocks/ProfileMocks.sol     configurable extension, non-extension, V2 implementation, tests only
  test/ProfileFuzz.t.sol     properties over usernames, keys, languages, values, item lists
  test/ProfileInvariant.t.sol  item-list and ownership invariants under random sequences
  README.md                  design, data model, gas, security review, frontend integration
ignition/modules/
  token.ts                   deploys contracts/token   (--sc token): the bridge tokens
  wnura.ts                   deploys contracts/token/WNURA.sol alone (--sc wnura)
  airdrop.ts                 deploys contracts/airdrop (--sc airdrop)
  univ3.ts                   deploys contracts/univ3   (--sc univ3)
  univ3periphery.ts          redeploys the WNURA-holding V3 periphery (--sc univ3periphery)
  forecast.ts                deploys contracts/forecast (--sc forecast)
  profile.ts                 deploys contracts/profile (--sc profile): impl, proxy, lens, verifier
  baziche.ts                 deploys contracts/baziche (--sc baziche): achievements and vault
scripts/
  preflight.ts               pre-deploy check: chain id, funding, gas, contract sizes, paid tables
  write-init-code-hash.ts    regenerates the V3 pool init code hash
  profile-setup.ts           registers the verifier extension on the profile registry, prints state
  profile-upgrade.ts         UUPS upgrade with owner, size and proxiableUUID checks
  profile-gas.ts             gas table for every profile operation
  lib/params.ts              deployment input parsing and formatting, shared and tested
test/
  BridgeToken.test.ts        49 tests: roles, mint, burn, pause, permit security, rescue
  Airdrop.test.ts            44 tests: signature binding, replay, reentrancy, caps, admin
  ArcadeVault.test.ts        39 tests: stakes, signatures, payouts, refunds, reclaims, roles, gas
  univ3/Build.test.ts        EIP-170 sizes and the pool init code hash
  univ3/Factory.test.ts      18 tests: fee tiers, createPool, ownership
  univ3/Pool.test.ts         26 tests: initialize, mint, burn, swap, flash, fees
  univ3/Liquidity.test.ts    15 tests: ranges, tick crossing, fee shares, TickMath
  univ3/Router.test.ts       20 tests: single/multi-hop, slippage, native, quoter
  univ3/Positions.test.ts    20 tests: NFT lifecycle, permit, tokenURI
  univ3/Oracle.test.ts       12 tests: observations, TWAP, cardinality at 3s blocks
  Profile.test.ts            70 tests: usernames, localization, items, operators, transfer,
                             extensions, verifier, upgrade, event replay
  scripts/params.test.ts     24 tests: deployment input parsing, away from any network
  scripts/modules.test.ts    Ignition module deployments: every module deployed and inspected
.github/workflows/ci.yml     build, Mocha, Solidity fuzz/invariant, coverage
hardhat.config.ts            three solc versions, networks, and the `deploy --sc` task
```

Each `contracts/<folder>` maps to `ignition/modules/<folder>.ts` and is deployed
independently with `--sc <folder>`. `wnura` and `univ3periphery` are the two groups that are not folders.
