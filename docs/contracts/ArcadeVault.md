# ArcadeVault

## Contract Overview

| Property | Value |
| --- | --- |
| Contract name | `ArcadeVault` |
| Solidity file | `contracts/baziche/ArcadeVault.sol` |
| Solidity version | `^0.8.28` (solc 0.8.28, cancun) |
| Contract type | Concrete, standalone (constructor-deployed) |
| Purpose | Holds the **native NURA** players stake on Arcade's paid tables: free balances only their owners can move, and stakes locked into one game that leave it only to its winners or back to its players |
| Upgradeable / Proxy | No / No |
| License | MIT |

A player deposits once and withdraws what is free whenever they like. Playing a game costs
them no transaction: they sign an EIP-712 `Stake` for that one game, and the Arcade server,
holding `REFEREE_ROLE`, opens the game with every player's signature and later pays it. The
games are played on the Arcade server, so the referee is trusted to say who won, and the
contract bounds everything else it can do (see **Security Analysis**).

## Inheritance

```text
ArcadeVault
├── AccessControlDefaultAdminRules -- one owner (DEFAULT_ADMIN_ROLE), handed on in two steps; PAUSER_ROLE, REFEREE_ROLE
├── Pausable         -- stops deposits and new games, nothing else
├── ReentrancyGuard  -- guards the two outward transfers (withdraw, withdrawFees)
└── EIP712           -- domain separator for signed stakes ("ArcadeVault", "1")
```

| Base | Why inherited |
| --- | --- |
| `AccessControlDefaultAdminRules` | Role gating for the owner, the pauser and the referee, with one owner handed on in two steps. |
| `Pausable` | `whenNotPaused` on `deposit`, `receive` and `open` only. |
| `ReentrancyGuard` | `nonReentrant` around `withdraw` and `withdrawFees`, the only calls that send coin. |
| `EIP712` | Binds every stake to this contract and this chain, so it cannot be replayed against another deployment or a fork. |

## Interfaces

- `SignatureChecker` (OpenZeppelin): a stake is valid when its player's key signed it, or,
  for a contract wallet, when the wallet's ERC-1271 `isValidSignature` says so.
- Pays out with `Address.sendValue`, and only from `withdraw` and `withdrawFees`.

## State Variables

| Variable | Type | Visibility | Mutability | Purpose |
| --- | --- | --- | --- | --- |
| `REFEREE_ROLE` | `bytes32` | public | constant | May open, settle and refund games. The Arcade server's key. |
| `PAUSER_ROLE` | `bytes32` | public | constant | May pause and unpause. |
| `reclaimAfter` | `uint256` | public | immutable | Seconds after `open` from which anybody may `reclaim` an unpaid game. |
| `fee` | `uint16` | public | mutable | Basis points a game opened now pays, unless its game has its own `gameFee`. |
| `gameFee` | `mapping(bytes32 => uint16)` | public | mutable | One game's own fee, keyed by `keccak256(bytes(game))`; 0 means it pays `fee`. |
| `referee` | `address` | public | mutable | The Arcade server's key, as last set by the constructor or `setReferee`. |
| `referralShare` | `uint16` | public | mutable | Basis points OF THE FEE each referred seat gives its referrer, for games opened now. |
| `maxStake` | `uint256` | public | mutable | The most one player may stake on one game. |
| `fees` | `uint256` | public | mutable | Fees taken and not yet withdrawn. |
| `totalBalances` | `uint256` | public | mutable | Sum of every free balance. |
| `totalLocked` | `uint256` | public | mutable | Sum of every stake in play. |
| `balanceOf` | `mapping(address => uint256)` | public | mutable | A player's free balance. |
| `lockedOf` | `mapping(address => uint256)` | public | mutable | A player's stakes in play. |
| `nonceUsed` | `mapping(address => mapping(bytes32 => bool))` | public | mutable | Stakes used or cancelled. |
| `referrerOf` | `mapping(address => address)` | public | mutable | Who brought each player in; written once, by the player's own `deposit(referrer)`. |
| `referralEarned` | `mapping(address => uint256)` | public | mutable | Everything each referrer has been credited. |
| `_games` | `mapping(bytes32 => Game)` | private | mutable | Every game ever opened, read through `gameOf`. |

## Structs / Enums

- `Status { None, Open, Settled, Refunded, Reclaimed }`. An id is used once, whatever became of it.
- `Seat { address player; bytes32 commit; bytes32 nonce; uint64 deadline; bytes signature }`,
  what `open` receives for each player, in seat order.
- `Game { Status status; uint16 feeBps; uint16 referralShare; uint64 openedAt; uint256 amount; bytes32 commits; address[] players }`.
  The fee and the referral share are both pinned when the game opens.

## Constants

| Constant | Value | Meaning |
| --- | --- | --- |
| `MIN_FEE_BPS` / `MAX_FEE_BPS` | 100 / 1,500 | The lowest and highest fee the admin can ever set (1% and 15%). |
| `MAX_REFERRAL_BPS` | 5,000 | The most of a seat's fee a referrer can be given (half). |
| `MIN_SEATS` / `MAX_SEATS` | 2 / 9 | Players in one game. |
| `MIN_RECLAIM_AFTER` / `MAX_RECLAIM_AFTER` | 1 day / 30 days | Bounds on `reclaimAfter`. |
| `MAX_STAKE_LIFE` | 1 day | The longest a stake may still have to run when it is used. |

## The signed stake

```text
Stake(address player, string game, uint256 amount, uint16 feeBps, bytes32 commit,
      bytes32 nonce, uint64 deadline)
```

Domain: `name "ArcadeVault"`, `version "1"`, the chain id and this contract's address.
`game` is hashed as EIP-712 hashes any string. `commit` is
`keccak256(abi.encode(secret))` for a 32-byte secret the referee made for this seat; the
secret is revealed by `settle`, which checks it. `stakeDigest` returns the digest for any
values, for servers and tests.

## Events

| Event | When |
| --- | --- |
| `Deposited(player, amount)` | `deposit` or a plain transfer |
| `Withdrawn(player, amount)` | `withdraw` |
| `Cancelled(player, nonce)` | `cancel` |
| `Opened(id, game, amount, feeBps, players, commits)` | `open` |
| `Staked(id, player, amount)` | `open`, once per seat |
| `Settled(id, winners, share, fee, secrets)` | `settle` |
| `Paid(id, player, amount)` | `settle`, once per winner |
| `ReferralPaid(id, player, referrer, amount)` | `settle`, once per seat whose player has a referrer |
| `ReferrerSet(player, referrer)` | `deposit(referrer)`, the one time it names a referrer |
| `ReferralShareChanged(previousShare, newShare)` | `setReferralShare`, and the constructor |
| `Refunded(id)` / `Reclaimed(id, by)` | `refund` / `reclaim` |
| `Returned(id, player, amount)` | `refund` and `reclaim`, once per seat |
| `FeeChanged`, `MaxStakeChanged`, `FeesWithdrawn` | the admin's calls (and the constructor for the first two) |
| `GameFeeChanged(gameHash, game, previousFee, newFee)` | `setGameFee` |
| `RefereeChanged(previousReferee, newReferee)` | `setReferee`, and the constructor |

Every per-player event indexes the player, so one address's whole history is one
`eth_getLogs` per event.

## Errors

| Error | Raised by |
| --- | --- |
| `ZeroAddress`, `ZeroAmount` | constructor, deposits, withdrawals, `open`, the admin's calls |
| `FeeOutOfRange(feeBps)` | constructor, `setFee`, `setGameFee` |
| `ReferralShareOutOfRange(shareBps)` | constructor, `setReferralShare` over `MAX_REFERRAL_BPS` |
| `BadReclaimDelay(reclaimAfter)` | constructor |
| `InsufficientBalance(available, required)` | `withdraw` |
| `InsufficientFees(available, required)` | `withdrawFees` |
| `GameExists(id)` | `open` on an id used before |
| `GameNotOpen(id)` | `settle`, `refund`, `reclaim` on a game that is not open |
| `BadSeatCount(seats)` | `open` with fewer than 2 or more than 9 |
| `StakeTooHigh(amount, maxStake)`, `FeeMismatch(signed, current)` | `open` |
| `DuplicatePlayer(player)` | `open` |
| `StakeExpired(player, deadline)`, `StakeTooLong(player, deadline)` | `open` |
| `NonceUsed(player, nonce)`, `InvalidSignature(player)`, `StakeUnfunded(player, available, required)` | `open` |
| `BadWinners(winners)`, `BadSecrets()` | `settle` |
| `TooEarly(id, due)` | `reclaim` before the delay |

`open` refuses a player BY NAME, so a referee that simulates the call first knows whose stake
stopped the game and can ask that player again.

## Functions

### Classification

| Function | Who | Paused? |
| --- | --- | --- |
| `deposit()`, `deposit(referrer)`, `receive()` | anybody | stopped |
| `withdraw(amount)` | the balance's owner | never |
| `cancel(nonce)` | the stake's player | never |
| `open(id, game, amount, feeBps, seats)` | referee | stopped |
| `settle(id, winners, secrets)` | referee | never |
| `refund(id)` | referee | never |
| `reclaim(id)` | anybody, after `reclaimAfter` | never |
| `setFee`, `setGameFee`, `setReferralShare`, `setMaxStake`, `withdrawFees`, `setReferee` | admin | never |
| `pause`, `unpause` | pauser | |

### open

Locks one game: for each seat, in order, the player must be distinct, the stake unexpired and
not good for more than `MAX_STAKE_LIFE`, its nonce unused, its signature valid for
`(player, game, amount, feeBps, commit, nonce, deadline)`, and the player's free balance at
least `amount`. `feeBps` must equal `feeOf(game)` - the game's own `gameFee`, or `fee` when it
has none - and `amount` must be at most `maxStake`. Every stake
moves from free to locked, every nonce is spent, and the game records its players, its amount,
its fee, the current `referralShare` and the hash of its seats' commits. All or nothing.

### settle

Pays one game. `winners` is a bitmask over the seats (bit i for seat i), non-empty and within
the seat count. Each secret must hash to its seat's commit, in order. The pot is
`amount × seats`, the fee `pot × feeBps / 10000` at the fee the game was opened at, and the rest
is split evenly among the winners; what the split leaves over joins the fee, so the pot is paid
to the last wei.

Each seat whose player has a `referrerOf` then gives that referrer
`amount × feeBps / 10000 × referralShare / 10000`, at the share pinned when the game opened.
The cut comes out of what would have gone to `fees`, never out of the winners' share, and it
can never exceed it: each seat's cut is at most half that seat's fee, and the seats' fees,
rounded down one by one, add up to no more than the pot's. Winnings and cuts are credited to
vault balances, so a referrer withdraws like anybody, paused or not; nothing is sent.

### deposit(referrer)

A deposit that also names who brought the caller in. It writes `referrerOf[caller]` only
while that is still empty and `referrer` is neither zero nor the caller; otherwise it is a
plain deposit and never reverts for it. Nothing else writes `referrerOf`: not the owner, not
the referee, and not a second deposit.

### refund / reclaim

Both return every stake of an open game to its player with no fee, so no referrer is paid. `refund` is the referee's;
`reclaim` is anybody's, from `openedAt + reclaimAfter`, and it moves coin only to that game's
own players.

### withdraw / withdrawFees

The only two calls that send coin, each after its state is written and behind
`nonReentrant`. A receiver that refuses the coin reverts the whole call and keeps the balance.

## Access Control

| Role | Granted to at deploy | Can |
| --- | --- | --- |
| `DEFAULT_ADMIN_ROLE` | `admin` | the owner: set the fee (1% to 15%, shared or per game), the referral share (up to half the fee) and the ceiling, take the fees, replace the referee, grant and revoke every other role, hand the vault on |
| `PAUSER_ROLE` | `admin` | pause and unpause deposits and new games |
| `REFEREE_ROLE` | `referee` | open, settle and refund games |

**Handing the vault to a new owner** takes two transactions, so a mistyped address cannot take
it: the owner calls `beginDefaultAdminTransfer(next)`, and nothing changes until `next` calls
`acceptDefaultAdminTransfer()`. Until then the owner can take it back with
`cancelDefaultAdminTransfer()` or name somebody else. On acceptance the old owner loses
`DEFAULT_ADMIN_ROLE` and `PAUSER_ROLE` and the new one holds both. `owner()` reads who holds it.
There is only ever one owner: `grantRole(DEFAULT_ADMIN_ROLE, …)` is refused.

**Fees per game.** `setFee` sets the fee every game pays by default; `setGameFee(game, feeBps)`
gives one game - by the name players sign, e.g. `"hokm"` - its own, and `setGameFee(game, 0)`
sends it back to the default. Both take 1% to 15% and apply to games opened from then on: a game
already open keeps the fee its players signed. `feeOf(game)` reads the fee a new game of it
must carry, which is what the referee asks players to sign.

**Replacing the referee** is one call: `setReferee(next)` revokes `REFEREE_ROLE` from `referee`
and grants it to `next`. Games already open stay payable by the new referee. A referee granted
besides with `grantRole` keeps its role until `revokeRole`.

Revoking `REFEREE_ROLE` is the kill switch if the server's key leaks: no game can be opened or
paid until a new referee is granted, and every open game can be reclaimed after the delay.

## Token / Financial Flow

```text
player --deposit--> free balance --open (signed)--> locked --settle--> winners' free balances
                         ^                             |       ├─> referrers' free balances (a cut of the fee)
                         |                             |       └─> fees (admin)
                         |                             └--refund / reclaim--> back to each player
                         └--withdraw--> player
```

At every moment the contract holds `totalBalances + totalLocked + fees` (plus anything forced
into it), which `solvent()` reports and the invariant suite holds after every call.

## Security Analysis

| Actor | Can | Cannot |
| --- | --- | --- |
| A player | deposit, withdraw what is free, sign a stake, cancel it, reclaim an unpaid game after the delay | move anybody else's coin, take a stake back out of a game in play, make `settle` fail |
| The referee | open a game every player signed for, pay its pot to some of its players, refund it | touch a free balance, raise a stake, change a signed fee, use a stake twice or past its deadline, pay anybody who was not at that game, settle without the secrets, stop a withdrawal |
| The admin | change the fee, the referral share and the ceiling for games not yet opened, pause new games, take the fees, move the roles | touch a balance or a game in play directly, or set or move anybody's referrer |

What a player does trust is the referee's word about who won, because the game is played off
chain. The commits make the dice and cards of a paid game checkable afterwards: the secrets
revealed by `settle`, together with the players' signatures from `open`, give the seed
Arcade drew the game from, so a finished game can be replayed and compared.

Known and accepted:

- **The admin can grant itself `REFEREE_ROLE`.** Roles are the admin's to move; the admin belongs
  behind a multisig before the vault holds real value.
- **A player can make `open` fail** by withdrawing or cancelling between signing and the open,
  costing the referee the gas of a failed call; the referee simulates first and drops that
  player's stake.
- **A player can name a second wallet of their own as referrer**, and so take back up to
  `MAX_REFERRAL_BPS` of the fee on their own games. The vault cannot tell two wallets of one
  person apart; the owner bounds what that is worth with `setReferralShare`.
- **Coin forced into the contract** (a self-destruct) is held and accounted to nobody.
- **A re-org that drops an `open`** leaves the referee's record ahead of the chain; `settle` then
  reverts `GameNotOpen`, and the referee opens it again with the same stakes if they are still
  good.

## Deployment Information

Deployed by the `baziche` Ignition group beside `ArcadeAchievements`:

```bash
npx hardhat deploy --sc baziche --network nurachain --parameters ./ignition/params.json
```

with `referee` (the Arcade server's key), and optionally `admin`, `fee` (basis points, default
500), `referralShare` (basis points of the fee, default 2,000), `maxStake` (wei, default 1,000 NURA) and `reclaimAfter` (seconds, default three days).
See `ignition/modules/baziche.ts`. Gas measured on the in-process chain: `open` 331k, 507k and
948k at 2, 4 and 9 seats; `settle` 89k, 86k and 131k, and 201k for nine seats with eight
referred. The runtime code is 24,097 bytes, 479 under EIP-170. Run
`npm run preflight:nurachain` first: besides the deploy gas it reads the chain's block time,
prices a nine-seat game at the referee's gas price, and sends the node an `open` and a
`settle` of every table size, refusing to go on if it will not take one (a nine-seat `open`
is about 3 KB of calldata).

## Integration Guide

1. A player deposits: `deposit{value: amount}()`, or `deposit{value: amount}(referrer)` to
   name who brought them in (only the first named referrer counts).
2. For each paid game, the server makes a 32-byte secret per seat, and each player signs the
   `Stake` with that seat's commit, a fresh nonce and a short deadline (Arcade uses thirty
   minutes).
3. The referee simulates `open` and sends it; a refusal names the player.
4. When the game ends the referee sends `settle` with the winners and the secrets, or `refund`
   if nobody won.
5. A player withdraws with `withdraw(amount)`, or returns an unpaid game's stakes with
   `reclaim(id)` once `reclaimAfter` has passed.

## Function Reference

| Function | Signature |
| --- | --- |
| `deposit` | `deposit() payable`, `deposit(address referrer) payable` |
| `withdraw` | `withdraw(uint256 amount)` |
| `cancel` | `cancel(bytes32 nonce)` |
| `open` | `open(bytes32 id, string game, uint256 amount, uint16 feeBps, (address,bytes32,bytes32,uint64,bytes)[] seats)` |
| `settle` | `settle(bytes32 id, uint256 winners, bytes32[] secrets)` |
| `refund` | `refund(bytes32 id)` |
| `reclaim` | `reclaim(bytes32 id)` |
| `setFee` | `setFee(uint16 newFee)` |
| `setGameFee` | `setGameFee(string game, uint16 newFee)` |
| `setReferralShare` | `setReferralShare(uint16 newShare)` |
| `setReferee` | `setReferee(address newReferee)` |
| `setMaxStake` | `setMaxStake(uint256 newMaxStake)` |
| `withdrawFees` | `withdrawFees(address to, uint256 amount)` |
| `pause` / `unpause` | `pause()` / `unpause()` |
| `gameOf` | `gameOf(bytes32 id) view returns (uint8 status, uint16 feeBps, uint64 openedAt, uint256 amount, address[] players, uint16 referralShare_)` |
| `feeOf` | `feeOf(string game) view returns (uint16)` |
| `stakeDigest` | `stakeDigest(address player, string game, uint256 amount, uint16 feeBps, bytes32 commit, bytes32 nonce, uint64 deadline) view returns (bytes32)` |
| `solvent` | `solvent() view returns (bool)` |
