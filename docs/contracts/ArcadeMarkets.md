# ArcadeMarkets

## Contract Overview

| Property | Value |
| --- | --- |
| Contract name | `ArcadeMarkets` |
| Solidity file | `contracts/baziche/ArcadeMarkets.sol` |
| Solidity version | `^0.8.28` (solc 0.8.28, cancun) |
| Contract type | Concrete, standalone (constructor-deployed) |
| Purpose | Pari-mutuel markets on Arcade's games in **native NURA**: many bettors back the outcomes of one game with stakes of their own, and the backers of the outcome that happened share the pool by their stakes, less the fee the market names |
| Upgradeable / Proxy | No / No |
| License | MIT |

A market is one question about one game ("who wins?"), its outcomes (2 to 16; an outcome is an
index the Arcade server gives a seat, a side or a draw), a pool for each outcome, and the positions
in them. Nobody is matched with anybody and nobody offers odds: the only money in a market is what
its bettors staked. The Arcade server decides who may bet and how much, and signs a `Ticket` for
each position; the contract takes no stake without one. The server settles a market from the
game's result as it recorded it; the contract cannot see a game and trusts its operator for the
result, which the dispute window and the expiry bound (below).

## Inheritance

```text
ArcadeMarkets
├── AccessControlDefaultAdminRules -- one owner (DEFAULT_ADMIN_ROLE), handed on in two steps; OPERATOR_ROLE; PAUSER_ROLE
├── Pausable                       -- stops new positions, nothing else
├── ReentrancyGuard                -- claim, withdrawFees
└── EIP712("ArcadeMarkets", "1")   -- the ticket's domain: this contract, this chain
```

## State Variables

| Name | Type | What it holds |
| --- | --- | --- |
| `operator` | `address` | the key tickets are signed with, as last set by the constructor or `setOperator` |
| `owed` | `uint256` | every stake of a market not yet resolved, and every share and refund not yet claimed |
| `fees` | `uint256` | the owner's: the fees of every market settled, less what was withdrawn |
| `disputeWindow` | `uint64` | how long a market settled from now on holds its winners from claiming |
| `_markets` | `mapping(bytes32 => Market)` | each market: the hash of its terms, what settling needs of them, its books |
| `_backing` | `mapping(bytes32 => mapping(uint8 => uint256))` | the stake on each outcome of each market |
| `_staked` | `mapping(bytes32 => mapping(address => uint256))` | each bettor's stake in each market |
| `_positions` | `mapping(bytes32 => Position)` | every position, by its ticket's id |

## Structs

| Name | Fields |
| --- | --- |
| `Terms` | `market`, `game`, `outcomes`, `closesAt`, `feeBps`, `maxStake`, `maxPerBettor`, `maxPool`, `minBettors`, `minOutcomes` |
| `Ticket` | `id`, `market`, `terms` (the hash of the market's terms), `bettor`, `outcome`, `amount` (wei), `deadline` |
| `Market` | `terms`, `state`, `outcomes`, `winner`, `backedOutcomes`, `minOutcomes`, `feeBps`, `bettors`, `minBettors`, `closesAt`, `claimableAt`, `pool`, `left`, `backingLeft` |
| `Position` | `market`, `bettor`, `outcome`, `claimed`, `amount` |

A market's limits are not kept: every ticket brings the terms it names, checked against the hash,
so they are read from the call. `State` is `None`, `Open`, `Settled` (its winners are paid),
`Refunded` (settled, but every stake goes back), `Cancelled` and `Expired`.

## Constants

| Name | Value |
| --- | --- |
| `OPERATOR_ROLE` | `keccak256("OPERATOR_ROLE")` |
| `PAUSER_ROLE` | `keccak256("PAUSER_ROLE")` |
| `MAX_FEE_BPS` | 500 (5% of a pool) |
| `MAX_OUTCOMES` | 16 |
| `MAX_MARKET_LIFE` | 1 day (the furthest a market may close, at its first ticket) |
| `MAX_TICKET_LIFE` | 1 hour |
| `EXPIRY` | 7 days after the close |
| `MAX_DISPUTE_WINDOW` | 1 day |

## Events

| Event | When |
| --- | --- |
| `MarketOpened(market, game, terms, outcomes, closesAt, feeBps)` | a market's first ticket |
| `Placed(ticket, market, bettor, outcome, amount)` | a position |
| `Settled(market, outcome, pool, fee, claimableAt)` | a market settled with winners |
| `Refunded(market, outcome)` | a market settled, every stake to go back |
| `Cancelled(market)` / `Expired(market)` / `Overturned(market)` | every stake to go back |
| `Claimed(ticket, bettor, amount)` | a share or a stake paid |
| `FeesWithdrawn(to, amount)` / `Funded(from, amount)` | fees out, fees in |
| `OperatorChanged(previous, next)` / `DisputeWindowChanged(previous, next)` | the owner's settings |
| the AccessControl and Pausable events | roles granted, revoked and handed on; pause and unpause |

## Errors

| Error | When |
| --- | --- |
| `ZeroAddress()` / `ZeroAmount()` | an operator or recipient of nobody; a stake, a withdrawal or a top-up of nothing |
| `InvalidTerms(market)` | a first ticket whose terms are out of bounds (outcomes 2-16, the fewest bettors and backed outcomes at least 2 and no more outcomes than there are, a fee at most 5%, limits above nothing, a close at most a day ahead) |
| `TermsMismatch(market, terms)` | terms that are not the ones the ticket names, or a ticket that names terms other than its market's |
| `TicketUsed(ticket)` | a ticket already placed |
| `NotBettor(ticket, bettor)` | a ticket placed or a position claimed by somebody it does not name |
| `WrongAmount(ticket, amount, sent)` | anything sent but the ticket's amount |
| `TicketExpired(ticket, deadline)` / `TicketTooLong(ticket, deadline)` | a ticket past its deadline, or good for more than an hour |
| `InvalidSignature(ticket)` | a ticket signed by anybody who does not hold OPERATOR_ROLE now, or malformed |
| `MarketClosed(market)` | a position from the second the market closes, or in a market resolved |
| `OutcomeOutOfRange(market, outcome)` | an outcome the market does not have |
| `StakeTooLarge` / `BettorLimit` / `PoolLimit` | a position, a bettor's stake or the pool over the terms' limits |
| `UnknownMarket(market)` / `MarketResolved(market, state)` | resolving a market that took no ticket, or one resolved already |
| `MarketOpen(market)` | settling before the close; claiming while open |
| `TooEarly(market, at)` | expiring before a week after the close |
| `NoTickets()` / `UnknownTicket(ticket)` / `AlreadyClaimed(ticket)` / `NothingOwed(ticket)` | claims of nothing, of a ticket never placed, twice, or of a losing position |
| `NotYetClaimable(market, claimableAt)` | a winner claiming in the dispute window |
| `NotSettled(market, state)` / `DisputeClosed(market, claimableAt)` | overturning a market not settled, or after its window |
| `DisputeWindowTooLong(window)` | a window over a day |
| `InsufficientFees(available, required)` | withdrawing more than the fees, or overturning a market whose fee was withdrawn |
| `EnforcedPause()` | a position while paused |
| `AccessControlUnauthorizedAccount(account, role)` | a role's call by anybody without it |

## Functions

### place

`place(Terms terms, Ticket ticket, bytes signature) payable`: takes exactly `ticket.amount` from
`ticket.bettor` (the sender), before the ticket's deadline and the market's close, once per ticket
id, signed by a key that holds OPERATOR_ROLE, for terms that hash to `ticket.terms` and name its
market, on an outcome the market has, within the position's, the bettor's and the pool's limits.
The first ticket of a market opens it: the terms are checked and the hash kept, so nobody pays to
open a market nobody bets on. Counts each bettor and each outcome once. Sends nothing.

### settle

`settle(bytes32 market, uint8 outcome)`, OPERATOR_ROLE, after the close: when nobody backed
`outcome`, fewer distinct bettors than `minBettors` bet, or fewer outcomes than `minOutcomes` were
backed, every stake goes back, no fee and at once (`Refunded`); otherwise the fee
(`pool * feeBps / 10_000`) goes to `fees`, `left` is the rest and `backingLeft` the outcome's pool,
and the winners claim from `claimableAt`, `disputeWindow` seconds later (`Settled`).

### cancel / expire / overturn

`cancel(market)`, OPERATOR_ROLE, while open (before or after the close): every stake back, for a
game with no result. `expire(market)`, anybody, a week after the close of a market nobody resolved:
every stake back. `overturn(market)`, DEFAULT_ADMIN_ROLE, in a settled market's dispute window:
undoes the settlement, every stake and the fee back (a fee already withdrawn is put back with
`fund` first).

### claim

`claim(bytes32[] tickets)`: pays the sender everything their named positions are owed, in one
transfer. A winning position is paid `left * stake / backingLeft`, both falling as each is paid, so
the last winner to claim is paid the exact remainder; a position in a market that refunds is paid
its stake. Refuses the whole list for one position not owed anything now. Never paused.

### The owner

`withdrawFees(to, amount)` (fees only), `fund()` (adds to fees), `setDisputeWindow(seconds)` (for
markets settled from then on, at most a day), `setOperator(next)` (moves OPERATOR_ROLE in one call;
tickets the old key signed stop at once), `pause()` / `unpause()` (PAUSER_ROLE: new positions only),
and the two-step handover of DEFAULT_ADMIN_ROLE, which carries PAUSER_ROLE with it.

### Views

`marketOf(market)`, `backingOf(market, outcome)`, `stakedOf(market, bettor)`, `positionOf(ticket)`,
`payoutOf(ticket)` (what a claim pays once its market's window has passed), `termsHash(terms)`,
`ticketDigest(ticket)` and `solvent()` (the balance covers `owed + fees`).

## Access Control

| Role | Held by | May |
| --- | --- | --- |
| `DEFAULT_ADMIN_ROLE` | the owner, handed on in two steps | withdraw and add fees, set the dispute window, replace the operator, overturn a settlement in its window, grant and revoke roles |
| `OPERATOR_ROLE` | the Arcade server's key (`NURA_REFEREE_KEY`) | sign tickets, settle and cancel markets |
| `PAUSER_ROLE` | the owner, moved with the contract | pause and unpause new positions |

## Token / Financial Flow

```text
bettor --place(terms, ticket, signature), value--> ArcadeMarkets            (owed += stake)
operator --settle(market, outcome)--> fee to `fees`, the rest owed to the winners
winner --claim(tickets)--> ArcadeMarkets --sendValue(share)--> winner      (owed -= share)
cancel / expire / overturn / Refunded --claim--> every stake back          (owed -= stake)
owner --withdrawFees(to, amount)--> fees out                               (fees -= amount)
```

Every unit is accounted: the balance is `owed + fees` exactly, unless coin was forced in (a
self-destruct), which is held and owed to nobody. A winning position's payout is rounded down, so
the remainder rides on to the last winner to claim, who is paid exactly what is left.

## Security Analysis

Read adversarially before it was called done, with the threat model below. The tests that hold
each point are named in parentheses.

- **A leaked or hostile operator key.** It decides results, so it is the key that matters. It can
  sign tickets (staking only the bettors' own coin, within each market's signed limits), cancel
  (which refunds) and settle. A settlement it makes its own way, after placing positions for
  itself, would pay it other bettors' stakes in that market. The dispute window is the defence:
  winners claim only once it has passed, and in it the owner overturns the settlement, which
  refunds everyone; the server's reconciliation compares every settlement on the chain with its own
  records and raises one it did not make. The owner then replaces the key with `setOperator`, which
  stops its tickets and its settling at once. Nothing the operator does can send a stake anywhere but
  to that market's own bettors. Residual: a window nobody watches is no defence, and a window of
  nothing is none at all (*disputes*; *domain binding*; *the owner*).
- **A hostile owner.** It appoints the operator, so a hostile owner is a hostile operator; it
  should be a multisig. Its own calls move no stake: fees only, and overturning only refunds.
- **Betting on a known result.** The contract knows only the close. A game can end inside its
  market's window (a walkout, a resignation), and a ticket signed before the end could then be
  placed on a result already decided. **The Arcade server must sign no ticket for a game that has
  finished and must cancel, not settle, a market whose game finished before the market closed.**
- **Replay.** A ticket is placed once ever (its id), only by the bettor it names, only before its
  deadline (at most an hour out) and the market's close, and only on this contract on this chain
  (the EIP-712 domain). Its signature covers the terms' hash, so a ticket for one market's terms
  cannot open or join another's (*input validation*; *domain binding*).
- **Reentrancy.** Coin leaves only in `claim` and `withdrawFees`, both nonReentrant, each after
  every position it pays is marked and every total written. `place` hands control to nobody. A
  receiver that calls back into `claim` is refused; one that places a position from inside a claim
  places a position of its own; one that refuses the coin reverts its claim with nothing marked
  (*reentrancy*).
- **Rounding.** Integer arithmetic in wei throughout. Each winner is paid at least the floor of its
  exact share, and the last to claim the exact remainder, whatever the order (*settling*; the fuzz
  run *winnersShareThePoolToTheWei*).
- **Unbounded work.** Nothing loops over bettors or positions: settling is constant work, and a
  claim pays the positions its caller names, as many as their transaction's gas allows.
- **Funds locked by an unexpected outcome.** Nobody backing the outcome that happened, too few
  bettors, too few backed outcomes, a cancel, an expiry and an overturn all refund in full with no
  fee; a market nobody resolves can be expired by anybody a week after its close (*settling*;
  *cancelling and expiring*; the invariant run).
- **A share nobody claims** stays theirs: there is no sweep.
- **Timestamps.** A block's time can move a few seconds; the close, the window and the expiry are
  minutes, hours and days.
- **A re-org** that drops a position or a settlement the server already read would leave its records
  ahead of the chain. The server reads what it believes only once mined, and on a chain that can
  re-organise mined blocks should read a few blocks deep.

## Deployment Information

Deployed by the `bazichemarkets` Ignition group, alone, so a chain that already holds the vault,
the achievements, the shop and the gifts' contract does not get a second of any of them:

```bash
npx hardhat deploy --sc bazichemarkets --network nurachain --parameters ./ignition/params.json
```

with `admin` (the owner's wallet or a multisig, default the deployer), `operator` (the Arcade
server's key, default the deployer, which is fine only on a local chain) and `disputeWindow` (900
seconds unless given). See `ignition/modules/bazichemarkets.ts`. Run `npm run preflight:nurachain`
first: it estimates the deployment with the rest.

Gas measured on the in-process chain: `place` 252,651 for a market's first ticket (it opens the
market), 174,104 for a new bettor on an outcome nobody had backed; `settle` 112,037; `claim`
62,269 for one position and 63,624 for two.

## Integration Guide

1. The server writes the market's terms when a game starts (its id, the game, the outcomes, the
   close, the fee, the limits, the fewest bettors and backed outcomes) and keeps them.
2. For each position it allows, it writes a ticket (its id, the market, the terms' hash, the
   bettor, the outcome, the exact amount, a deadline) and signs it (EIP-712, domain
   `ArcadeMarkets`, version `1`, this chain, this contract).
3. The bettor's wallet sends `place(terms, ticket, signature)` with the amount as its value.
4. The server reads `positionOf(ticket)`: a bettor that is not the zero address is a position. It
   checks the market, the bettor, the outcome and the amount against what it wrote.
5. Once the game is over and the market closed, the server sends `settle(market, outcome)`, or
   `cancel(market)` for a game with no result or one that finished before its market closed.
6. Each bettor claims with `claim(tickets)` once `payoutOf` says something and, for a market with
   winners, `claimableAt` has passed.

## Function Reference

| Function | Signature |
| --- | --- |
| `place` | `place((bytes32,bytes32,uint8,uint64,uint16,uint256,uint256,uint256,uint32,uint8) terms, (bytes32,bytes32,bytes32,address,uint8,uint256,uint64) ticket, bytes signature) payable` |
| `claim` | `claim(bytes32[] tickets)` |
| `settle` | `settle(bytes32 market, uint8 outcome)` |
| `cancel` | `cancel(bytes32 market)` |
| `expire` | `expire(bytes32 market)` |
| `overturn` | `overturn(bytes32 market)` |
| `withdrawFees` | `withdrawFees(address to, uint256 amount)` |
| `fund` | `fund() payable` |
| `setDisputeWindow` | `setDisputeWindow(uint64 window)` |
| `setOperator` | `setOperator(address next)` |
| `pause` / `unpause` | `pause()` / `unpause()` |
| `marketOf` | `marketOf(bytes32 market) view returns (Market)` |
| `backingOf` | `backingOf(bytes32 market, uint8 outcome) view returns (uint256)` |
| `stakedOf` | `stakedOf(bytes32 market, address bettor) view returns (uint256)` |
| `positionOf` | `positionOf(bytes32 ticket) view returns (bytes32 market, address bettor, uint8 outcome, uint256 amount, bool claimed)` |
| `payoutOf` | `payoutOf(bytes32 ticket) view returns (uint256)` |
| `termsHash` | `termsHash(Terms terms) pure returns (bytes32)` |
| `ticketDigest` | `ticketDigest(Ticket ticket) view returns (bytes32)` |
| `solvent` | `solvent() view returns (bool)` |
