# ArcadeLooks

## Contract Overview

| Property | Value |
| --- | --- |
| Contract name | `ArcadeLooks` |
| Solidity file | `contracts/baziche/ArcadeLooks.sol` |
| Solidity version | `^0.8.28` (solc 0.8.28, cancun) |
| Contract type | Concrete, standalone (constructor-deployed) |
| Purpose | Holds the looks Arcade's players own as **soulbound ERC-1155** tokens, minted and burned by the Arcade server's minter wallet |
| Upgradeable / Proxy | No / No |
| License | MIT |

A look (dice, pawns, a card back, an avatar decoration, a profile theme...) is paid for in
`ArcadeShop`, and owned where the Arcade server keeps it. This contract is the proof of it: once a
look is somebody's, the server mints its token into their own wallet, and nobody, them included,
can move it. A look bought for a friend is minted into the friend's wallet. When the shop refunds a
look, or the staff take one back, the server burns it.

## Inheritance

```text
ArcadeLooks
├── ERC1155                         -- the tokens, and the {id} metadata template
└── AccessControlDefaultAdminRules  -- one owner (DEFAULT_ADMIN_ROLE), handed on in two steps; MINTER_ROLE
```

## Token ids

`id = uint256(keccak256(bytes(itemId)))`, the server's own item id (`dice.shiraz`): no registry to
keep in step with the catalogue. The metadata JSON (name, picture, kind, collection, tier) is the
server's, under the `{id}` template, the id as 64 lower-case hex digits.

## Roles

| Role | Held by | May |
| --- | --- | --- |
| `DEFAULT_ADMIN_ROLE` | the owner | grant and revoke `MINTER_ROLE`, `setURI`, hand the contract on in two steps |
| `MINTER_ROLE` | the Arcade server's minter wallet | `mint`, `mintBatch`, `burn` |

A leaked minter key can mint cosmetics nobody can move and burn ones it minted; it moves no coin
and no token between wallets. Revoking `MINTER_ROLE` ends it.

## Functions

| Function | Who | Reverts |
| --- | --- | --- |
| `mint(owner, id)` | `MINTER_ROLE` | `ZeroAddress`, `AlreadyHeld(owner, id)` while `owner` holds one, `ERC1155InvalidReceiver` for a contract that takes no ERC-1155 |
| `mintBatch(owner, ids)` | `MINTER_ROLE` | as `mint`, for the whole batch: one look already held, or named twice, gives none of them |
| `burn(owner, id)` | `MINTER_ROLE` | `NotHeld(owner, id)` |
| `setURI(newUri)` | `DEFAULT_ADMIN_ROLE` | |
| `holders(id)` | view | |
| `safeTransferFrom` / `safeBatchTransferFrom` | nobody | `Soulbound(id)`, always |

## Where it parts from ArcadeAchievements

- **Every token is soulbound.** There is no tradeable kind: a look is not resold.
- **The minter can burn.** A refund takes the look back; a token that outlived it would prove
  something untrue. Holders cannot burn.
- **The guard is the balance.** An achievement is earned once for good; a refunded look can be
  bought again, so a wallet may be given a look once it holds none of it.

## Security notes

- A server retry after a lost receipt mints nothing twice: `AlreadyHeld`.
- `mintBatch` checks every id before any balance moves, so a look named twice in one batch is
  refused rather than minted twice.
- Approvals are left as ERC-1155 has them; with every move refused they grant nothing.
- No upgradeability, no supply cap, no royalties.

## Deployment

The `bazichelooks` Ignition group, alone, so a chain that already holds the vault, the
achievements, the shop, the gifts' contract and the markets is not given a second of each:

```bash
npx hardhat deploy --sc bazichelooks --network nurachain --parameters ./ignition/params.json
```

```json
{ "bazichelooks": { "admin": "0xYourAdminWallet", "uri": "https://baziche.com/api/nft/looks/{id}.json" } }
```

Then, from the admin: `grantRole(MINTER_ROLE, minter)` for the server's `NURA_MINTER_KEY` address.
