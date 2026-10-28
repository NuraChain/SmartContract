# ArcadeTips

## Contract Overview

| Property | Value |
| --- | --- |
| Contract name | `ArcadeTips` |
| Solidity file | `contracts/baziche/ArcadeTips.sol` |
| Solidity version | `^0.8.28` (solc 0.8.28, cancun) |
| Contract type | Concrete, standalone (constructor-deployed) |
| Purpose | Passes **native NURA** from somebody watching a game on Arcade to a player of it, in the call that sends it, and records the gift under its giver and the id the Arcade server gave it |
| Upgradeable / Proxy | No / No |
| License | MIT |

A watcher gives NURA to a player of the game they watch. The Arcade server decides whether that
gift may be made (who gives, to whom, how much), writes the donation with an id of its own and
hands the browser an unsent call, `tip(id, player, deadline)` with the amount as its value, which the
giver's wallet sends. The contract forwards the whole value to the player at once and records
`{ to, amount, givenAt }` under `(giver, id)`. The server confirms the gift by asking `tipOf(giver,
id)`, never by a hash the page reports, so a transaction the wallet sped up or re-priced is found
all the same. Nothing stays in the contract and no fee is taken.

## Inheritance

```text
ArcadeTips
├── AccessControlDefaultAdminRules -- one owner (DEFAULT_ADMIN_ROLE), handed on in two steps; PAUSER_ROLE
└── Pausable                       -- stops new gifts, nothing else
```

## State Variables

| Name | Type | What it holds |
| --- | --- | --- |
| `_tips` | `mapping(address => mapping(bytes32 => Tip))` | every gift, by its giver and its id |

## Structs

| Name | Fields |
| --- | --- |
| `Tip` | `to` (the player), `givenAt` (the block's time), `amount` (wei) |

## Constants

| Name | Value |
| --- | --- |
| `PAUSER_ROLE` | `keccak256("PAUSER_ROLE")` |

## Events

| Event | When |
| --- | --- |
| `Tipped(from, id, to, amount)` | a gift is recorded, just before its coin leaves |
| the AccessControl and Pausable events | roles granted, revoked and handed on; pause and unpause |

## Errors

| Error | When |
| --- | --- |
| `ZeroAddress()` | a gift to the zero address |
| `SelfTip()` | a gift to oneself |
| `ZeroAmount()` | a gift of nothing |
| `TipUsed(from, id)` | the giver has used that id before |
| `TipExpired(from, id, deadline)` | a call after the deadline it carries |
| `EnforcedPause()` | a gift while paused |
| `AccessControlUnauthorizedAccount(account, role)` | a pause or unpause by anybody but a pauser |

## Functions

### tip

`tip(bytes32 id, address to, uint64 deadline) payable`: refuses the zero address, oneself, nothing
sent, a call past its deadline and an id the caller already used, then records the gift and sends `msg.value` to `to` with
`Address.sendValue`. A receiver that refuses the coin reverts the whole gift, so nothing is
recorded and nothing moved. A receiver that calls back in finds the gift already recorded; it can
give onward with its own coin, under its own address, and nothing else.

### tipOf

`tipOf(address from, bytes32 id) view returns (address to, uint256 amount, uint64 givenAt)`: one gift;
a receiver of the zero address means that giver never used that id.

### pause / unpause

`PAUSER_ROLE` only. Stops new gifts and starts them again. Reading a gift is never paused.

## Access Control

| Role | Held by | May |
| --- | --- | --- |
| `DEFAULT_ADMIN_ROLE` | the owner, handed on in two steps (`beginDefaultAdminTransfer`, `acceptDefaultAdminTransfer`) | grant and revoke roles |
| `PAUSER_ROLE` | the owner, moved with the contract when it is handed on | pause and unpause |

Nobody may move a gift: there is no coin to move.

## Token / Financial Flow

```text
giver's wallet --tip(id, player), value--> ArcadeTips --sendValue(value)--> player
                                              └── records (giver, id) -> { player, value, time }
```

The contract's balance is nothing before a call and nothing after it. No fee, no withdrawal, no
refund: a gift that cannot be delivered reverts and stays in the giver's wallet.

## Security Analysis

- **Somebody spending a giver's id first.** A gift is keyed by its giver as well as its id, so
  the same call sent from another wallet is recorded under that wallet and the real gift still
  goes through. The server reads the record under the giver's own wallet.
- **A hostile receiver.** `sendValue` forwards all remaining gas, so a contract receiving a gift
  runs code inside it. The record is written first; what the receiver can do is refuse (the gift
  reverts) or give onward with the coin it was just given. The contract holds no coin a receiver
  could reach.
- **A call made late.** The server gives every gift a deadline and lets go of one that has run out;
  without the deadline in the call, a wallet that sent it an hour later would make a gift the
  server had already called expired. The contract refuses it instead, so the server's word stands.
- **No server signature.** Whether a gift may be made is the server's to decide before it hands
  out the call; the contract checks only what it can (somebody, not oneself, something, an id
  once). A gift made without the server, by somebody calling the contract directly, is a gift
  nobody counts: the server reads only ids it made.
- **Coin forced into the contract** (a self-destruct) is held and accounted to nobody.
- **A re-org that drops a `tip`** after the server confirmed it would leave a gift told and not
  given. The server reads a gift only once it is mined; on a chain that can re-organise mined
  blocks it should read it a few blocks deep.

## Deployment Information

Deployed by the `bazichetips` Ignition group, alone, so a chain that already holds the vault, the
achievements and the shop does not get a second of any of them:

```bash
npx hardhat deploy --sc bazichetips --network nurachain --parameters ./ignition/params.json
```

with `admin` (the owner's wallet, default the deployer). See `ignition/modules/bazichetips.ts`.
Gas measured on the in-process chain: `tip` 81,080 for a giver's gift to a player who already holds coin (two new storage slots and the payment), paid by the giver. Run
`npm run preflight:nurachain` first: it estimates the deployment with the rest.

## Integration Guide

1. The server writes the donation with an id (32 bytes) and a deadline, and hands the browser the
   call: `tip(id, player, deadline)` with the amount in wei as its value.
2. The giver's wallet sends it.
3. The server reads `tipOf(giver, id)`: a receiver that is not the zero address is a gift. It
   checks the receiver and the amount against what it wrote before it believes it.
4. A donation the wallet never sent is retried under the same id; one that reverted gets a new id.

## Function Reference

| Function | Signature |
| --- | --- |
| `tip` | `tip(bytes32 id, address to, uint64 deadline) payable` |
| `tipOf` | `tipOf(address from, bytes32 id) view returns (address to, uint256 amount, uint64 givenAt)` |
| `pause` | `pause()` |
| `unpause` | `unpause()` |
