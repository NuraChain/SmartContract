# ArcadeShop

## Contract Overview

| Property | Value |
| --- | --- |
| Contract name | `ArcadeShop` |
| Solidity file | `contracts/baziche/ArcadeShop.sol` |
| Solidity version | `^0.8.28` (solc 0.8.28, cancun) |
| Contract type | Concrete, standalone (constructor-deployed) |
| Purpose | Sells Arcade's looks for **native NURA**: a buyer pays from their own wallet a quote the Arcade server signed, the price becomes the owner's revenue less a share for whoever brought the buyer in, and the sale is what the server reads before it hands the look over |
| Upgradeable / Proxy | No / No |
| License | MIT |

The Arcade server prices every sale. It signs an EIP-712 `Quote` for one order, one buyer and
one price, good for a short while, with the key that holds `SELLER_ROLE`; the buyer sends that
quote with exactly its price to `buy`. The contract takes the payment only as it was signed, so a
wrong payment - another buyer, another price, an expired quote, an order already sold - never
leaves the buyer's wallet. The server then reads `saleOf(order)` and delivers. It never holds
NURA and never takes the browser's word for a payment.

## Inheritance

```text
ArcadeShop
├── AccessControlDefaultAdminRules -- one owner (DEFAULT_ADMIN_ROLE), handed on in two steps; PAUSER_ROLE, SELLER_ROLE
├── Pausable         -- stops new sales, nothing else
├── ReentrancyGuard  -- guards the three outward transfers (refund, withdraw, claim)
└── EIP712           -- domain separator for signed quotes ("ArcadeShop", "1")
```

| Base | Why inherited |
| --- | --- |
| `AccessControlDefaultAdminRules` | Role gating for the owner, the pauser and the seller, with one owner handed on in two steps. |
| `Pausable` | `whenNotPaused` on `buy` only. |
| `ReentrancyGuard` | `nonReentrant` around `refund`, `withdraw` and `claim`, the only calls that send coin. |
| `EIP712` | Binds every quote to this contract and this chain, so it cannot be replayed against another deployment or a fork. |

## Interfaces

- `ECDSA` (OpenZeppelin): a quote is good when it recovers, without malleability, to an address
  holding `SELLER_ROLE`. The seller is the server's own key, never a contract wallet.
- Pays out with `Address.sendValue`, and only from `refund`, `withdraw` and `claim`.
- No `receive` and no `fallback`: coin comes in through `buy`, and through the owner's `fund`.

## State Variables

| Variable | Type | Visibility | Mutability | Purpose |
| --- | --- | --- | --- | --- |
| `SELLER_ROLE` | `bytes32` | public | constant | May sign quotes. The Arcade server's key. |
| `PAUSER_ROLE` | `bytes32` | public | constant | May pause and unpause new sales. |
| `seller` | `address` | public | mutable | The seller as last set by the constructor or `setSeller`. |
| `referralBps` | `uint16` | public | mutable | Basis points of a sale credited to its buyer's inviter, for sales from now on. |
| `revenue` | `uint256` | public | mutable | The owner's: every price less its inviter's cut, less refunds and withdrawals, plus top-ups. |
| `totalEarnings` | `uint256` | public | mutable | Sum of every inviter's unclaimed credit. |
| `earnings` | `mapping(address => uint256)` | public | mutable | What each inviter can claim now. |
| `_sales` | `mapping(bytes32 => Sale)` | private | mutable | Every order ever sold, read through `saleOf`. |

## Structs

- `Quote { bytes32 order; address buyer; bytes32 item; uint256 price; address referrer; uint64 deadline }`,
  what the seller signs and `buy` receives.
- `Sale { address buyer; uint64 paidAt; bool refunded; address referrer; uint256 price; uint256 cut }`.
  A buyer of the zero address means the order was never sold; an order is sold once ever,
  refunded or not.

## Constants

| Constant | Value | Meaning |
| --- | --- | --- |
| `MAX_REFERRAL_BPS` | 3,000 | The most of a sale an inviter can ever be credited (30%). |
| `MAX_QUOTE_LIFE` | 1 day | The longest a quote may still have to run when it is used. |

## The signed quote

```text
Quote(bytes32 order, address buyer, bytes32 item, uint256 price, address referrer,
      uint64 deadline)
```

Domain: `name "ArcadeShop"`, `version "1"`, the chain id and this contract's address. `order` is
the server's id for one order, `item` the server's name for what is bought (recorded in
`Bought`), `referrer` whoever brought the buyer in or the zero address. `quoteDigest` returns the
digest for any quote, for servers and tests.

## Events

| Event | When |
| --- | --- |
| `Bought(order, buyer, item, price, referrer, cut)` | A sale; `referrer` is zero and `cut` nothing when nobody is credited. |
| `Refunded(order, buyer, price, fromEarnings)` | A sale given back in full; `fromEarnings` is the part taken back from the inviter's unclaimed credit. |
| `Claimed(referrer, amount)` | An inviter took their credit. |
| `Withdrawn(to, amount)` | The owner took revenue. |
| `Funded(from, amount)` | The owner topped revenue up. |
| `SellerChanged(previousSeller, newSeller)` | At deploy and on `setSeller`. |
| `ReferralBpsChanged(previousBps, newBps)` | At deploy and on `setReferralBps`. |

## Errors

| Error | Raised by |
| --- | --- |
| `ZeroAddress()` | a zero seller, a zero `withdraw` receiver |
| `ZeroAmount()` | a quote priced at nothing, a withdrawal or a top-up of nothing |
| `ReferralBpsOutOfRange(bps)` | a share over `MAX_REFERRAL_BPS` |
| `OrderSold(order)` | `buy` of an order already sold, refunded or not |
| `NotBuyer(order, buyer)` | `buy` from anybody but the quote's buyer |
| `WrongPrice(order, price, sent)` | `buy` sent anything but the quote's price |
| `QuoteExpired(order, deadline)` | `buy` after the quote's deadline |
| `QuoteTooLong(order, deadline)` | `buy` of a quote still good for more than `MAX_QUOTE_LIFE` |
| `InvalidSignature(order)` | a quote not signed, without malleability, by a holder of `SELLER_ROLE` |
| `NotSold(order)` | `refund` of an order never sold |
| `AlreadyRefunded(order)` | `refund` of a sale already refunded |
| `InsufficientRevenue(available, required)` | a `refund` or `withdraw` revenue cannot cover |
| `NothingToClaim()` | `claim` by somebody with no credit |

## Functions

### Classification

| Function | Who | Paused? | Sends coin? |
| --- | --- | --- | --- |
| `buy` | the quote's buyer | stops | no |
| `claim` | an inviter | carries on | to the caller |
| `refund` | the owner | carries on | to the sale's buyer |
| `withdraw` | the owner | carries on | to the owner's choice |
| `fund` | the owner | carries on | no |
| `setSeller`, `setReferralBps` | the owner | carries on | no |
| `pause`, `unpause` | the pauser | - | no |

### buy

Checks, in this order, so a wallet that simulates the call first says why: the order has not been
sold (`OrderSold`), the caller is the quote's buyer (`NotBuyer`), the price is above nothing
(`ZeroAmount`), exactly the price was sent (`WrongPrice`), the deadline has not passed
(`QuoteExpired`) and is no more than a day away (`QuoteTooLong`), and the quote recovers to a
holder of `SELLER_ROLE` (`InvalidSignature`). A referrer that is the buyer is no referrer. The
inviter is credited `price * referralBps / 10000`, the rest is revenue. It hands control to
nobody.

### refund

The owner gives one sale's whole price back to its buyer. The inviter's cut is taken back from
their unclaimed credit as far as it reaches, whichever sale earned it; whatever they already
claimed comes out of revenue, so the buyer is always paid in full. Revenue that cannot cover it
is `InsufficientRevenue` until the owner tops it up with `fund`.

### claim / withdraw

Each sends coin after its state is written and behind `nonReentrant`. A receiver that refuses the
coin reverts the whole call and keeps the credit or the revenue. `withdraw` takes revenue only,
never what inviters have still to claim.

## Access Control

| Role | Granted to at deploy | Can |
| --- | --- | --- |
| `DEFAULT_ADMIN_ROLE` | `admin` | the owner: refund a sale, take and top up revenue, set the inviters' share (0 to 30%), replace the seller, grant and revoke every other role, hand the shop on |
| `PAUSER_ROLE` | `admin` | pause and unpause new sales |
| `SELLER_ROLE` | `seller` | sign quotes |

**Handing the shop to a new owner** takes two transactions, as the vault's does:
`beginDefaultAdminTransfer(next)`, then `acceptDefaultAdminTransfer()` from `next`;
`cancelDefaultAdminTransfer()` takes a naming back. On acceptance the old owner loses
`DEFAULT_ADMIN_ROLE` and `PAUSER_ROLE` and the new one holds both.

**Replacing the seller** is one call: `setSeller(next)` revokes `SELLER_ROLE` from `seller` and
grants it to `next`, and every quote the old key signed stops being good at once. A seller
granted besides with `grantRole` keeps its role until `revokeRole`. Revoking the role is the kill
switch if the server's key leaks.

## Token / Financial Flow

```text
buyer --buy (quote)--> price ─┬─> revenue ──withdraw──> the owner's choice
                              └─> earnings[inviter] ──claim──> inviter
refund: price --> buyer, out of the inviter's unclaimed credit first, then revenue
fund:   owner --> revenue
```

At every moment the contract holds `revenue + totalEarnings` (plus anything forced into it),
which `solvent()` reports and the invariant suite holds after every call.

## Security Analysis

| Actor | Can | Cannot |
| --- | --- | --- |
| A buyer | pay a quote made out to them, at its price, before its deadline | pay another buyer's quote, pay a different price, pay an order twice, pick their own inviter |
| An inviter | claim what they were credited | touch anybody else's credit or the revenue |
| The seller | sign quotes, and so give looks away at any price above nothing | move coin, refund, withdraw, take revenue or credit |
| The owner | refund a sale to its buyer, take and top up revenue, set the share for future sales, move the roles, pause | take an inviter's credit except through the refund of the sale that earned it, send a refund anywhere but to the buyer, change a sale already made |

Known and accepted:

- **A leaked seller key gives looks away.** It can sign a quote at any price above nothing, so
  whoever holds it can buy looks for a wei. It cannot move a wei of anybody's. `setSeller` or
  `revokeRole` ends it, and every quote it signed stops being good at once.
- **The owner can grant itself `SELLER_ROLE`.** Roles are the owner's to move; the owner belongs
  behind a multisig before the shop holds real value.
- **Somebody can be their own inviter through a second account**, if the server credits the
  account that brought the second one in: up to `referralBps` back on their own purchases. The
  contract cannot tell two accounts of one person apart; the owner bounds what it is worth with
  `setReferralBps`.
- **A buyer contract that refuses coin cannot be refunded on chain**: the refund reverts and the
  sale stays as it was.
- **Coin forced into the contract** (a self-destruct) is held and accounted to nobody.
- **A re-org that drops a `buy`** after the server delivered would leave a look delivered and not
  paid for. The server reads a sale only once it is mined; on a chain that can re-organise mined
  blocks it should read it a few blocks deep.

## Deployment Information

Deployed by the `bazicheshop` Ignition group, alone, so a chain that already holds the vault and
the achievements does not get a second of either:

```bash
npx hardhat deploy --sc bazicheshop --network nurachain --parameters ./ignition/params.json
```

with `seller` (the Arcade server's key, its `NURA_REFEREE_KEY`), and optionally `admin` and
`referralBps` (basis points of a sale, default 1,000). See `ignition/modules/bazicheshop.ts`.
Gas measured on the in-process chain: `buy` 109k for the shop's first sale and 179k for a first
sale with an inviter to credit; later sales cost less, since the totals are already written. Run
`npm run preflight:nurachain` first: it sends the node a `buy` and prices one at the floor.

## Integration Guide

1. The server writes an order and signs its `Quote`: the order's id, the buyer's wallet, the
   item, the price in wei, the buyer's inviter or nobody, and a deadline (Arcade uses thirty
   minutes).
2. The buyer's wallet sends `buy(quote, signature)` with exactly the price.
3. The server reads `saleOf(order)`: a buyer that is not the zero address is a sale. It needs no
   transaction hash, so a closed tab loses nothing.
4. The owner refunds a sale with `refund(order)`; the server sees `refunded` and takes the look
   back.
5. An inviter claims with `claim()`; the owner takes revenue with `withdraw(to, amount)`.

## Function Reference

| Function | Signature |
| --- | --- |
| `buy` | `buy((bytes32,address,bytes32,uint256,address,uint64) quote, bytes signature) payable` |
| `claim` | `claim()` |
| `refund` | `refund(bytes32 order)` |
| `withdraw` | `withdraw(address to, uint256 amount)` |
| `fund` | `fund() payable` |
| `setSeller` | `setSeller(address newSeller)` |
| `setReferralBps` | `setReferralBps(uint16 newBps)` |
| `pause` / `unpause` | `pause()` / `unpause()` |
| `saleOf` | `saleOf(bytes32 order) view returns (address buyer, uint64 paidAt, bool refunded, address referrer, uint256 price, uint256 cut)` |
| `quoteDigest` | `quoteDigest((bytes32,address,bytes32,uint256,address,uint64) quote) view returns (bytes32)` |
| `solvent` | `solvent() view returns (bool)` |
