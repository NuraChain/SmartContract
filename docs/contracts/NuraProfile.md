# NuraProfile

## Contract Overview

| Property | Value |
| --- | --- |
| Contract name | `NuraProfile` (behind `NuraProfileProxy`; read model in `NuraProfileLens`) |
| Solidity file | `contracts/profile/NuraProfile.sol` |
| Solidity version | `^0.8.28`, compiled **viaIR**, optimizer 200 runs, EVM `cancun` (folder override in `hardhat.config.ts`) |
| Contract type | UUPS-upgradeable singleton behind an ERC-1967 proxy; ERC-7201 namespaced storage |
| Purpose | Decentralized profile registry for the Nura ecosystem: one profile per address, unique usernames, localizable key/value fields, generic item collections (websites, images, socials, any future kind), owner-approved operators, two-step transfer with a recovery address, and a curated registry of extension contracts that write into their own namespace |
| Runtime size | 21 502 bytes (EIP-170 limit 24 576; Nurachain enforces it exactly) |

The full design rationale — why generic storage instead of a schema, why UUPS + sidecar
extensions instead of a Diamond, why the read model is a separate contract — is in
[`contracts/profile/README.md`](../../contracts/profile/README.md). This page is the per-function
reference.

## Inheritance

```text
NuraProfile
├── INuraProfile               -- full external surface + events
├── Initializable              -- initializer / reinitializer guards
├── Ownable2StepUpgradeable    -- contract admin (upgrade, extension registry, reservations)
├── UUPSUpgradeable            -- upgradeToAndCall, _authorizeUpgrade = onlyOwner
└── ERC165Upgradeable          -- supportsInterface(INuraProfile)

NuraProfileProxy  is ERC1967Proxy          (the address everyone uses)
NuraProfileLens   (stateless, reads core via INuraProfile)
SocialVerifier    is IProfileExtension, AccessControl, EIP712   (reference extension)
```

## Interfaces

| Interface | Interaction |
| --- | --- |
| `INuraProfile` | Implemented surface; the ABI wallets, indexers and extensions consume. |
| `IProfileExtension` (`extensionId`, `profileRegistry`, ERC-165) | Handshake checked in `registerExtension`. |
| `IERC165` | Via `ERC165Checker` during registration only. |

## Storage

One struct at `keccak256(abi.encode(uint256(keccak256("nura.storage.NuraProfile")) - 1)) & ~0xff`
= `0x2fd3cb398506b389565dadff107316c87c7c92d40494549e70e4bd092e543300` (pinned by test).

| Member | Type | Purpose |
| --- | --- | --- |
| `nextProfileId` | `uint256` | Ids issued so far; ids start at 1 and are never reused. |
| `profiles` | `mapping(uint256 => ProfileRecord)` | `owner`, `createdAt`/`updatedAt` (uint40, packed with owner), `username` (bytes32), `pendingOwner` + `nextItemId` (packed), `recovery`. |
| `profileIdOf` | `mapping(address => uint256)` | The one profile an address owns (0 = none). |
| `usernameToProfile` | `mapping(bytes32 => uint256)` | Normalized username → profile id. |
| `reservations` | `mapping(bytes32 => Reservation{claimant, active})` | Admin reservations; `claimant == 0` blocks everyone. |
| `operators` | `mapping(address owner => mapping(address => bool))` | Owner-keyed content editors (ERC-721 `setApprovalForAll` semantics). |
| `fields` | `mapping(pid => mapping(bytes32 key => mapping(bytes32 lang => string)))` | Owner-written values; `lang == 0` is the default language. |
| `items` | `mapping(pid => mapping(itemId => ItemRecord{bytes28 kind, uint32 index}))` | One slot per item; `kind == 0` = absent. |
| `itemIds` | `mapping(pid => mapping(bytes32 kind => uint32[]))` | Ordered live ids per kind (swap-and-pop). |
| `itemAttributes` | `mapping(pid => mapping(itemId => mapping(key => mapping(lang => string))))` | Item attribute bag. |
| `extensions` / `extensionIdOf` / `extensionIds` / `extensionIndex` | registry | id ↔ address, enumeration with O(1) removal. |
| `extensionApprovals` | `mapping(pid => mapping(bytes32 extId => bool))` | Per-profile owner opt-in. |
| `extensionFields` | `mapping(pid => mapping(extId => mapping(key => mapping(lang => string))))` | Extension-written namespaces. |

## Constants

| Constant | Value | Purpose |
| --- | --- | --- |
| `VERSION` | `"1.0.0"` | Post-upgrade sanity check. |
| `MAX_VALUE_LENGTH` | `4096` | Bytes per stored value; larger content belongs off-chain by URI. |
| `MIN_USERNAME_LENGTH` / `MAX_USERNAME_LENGTH` | `3` / `32` | After lower-casing. |

Identifier rules (`ProfileStrings`): keys 1..32 printable non-space ASCII; kinds 1..28; language
tags empty or 1..32 of `[A-Za-z0-9-]` lower-cased; usernames 3..32, lower-cased, `[a-z0-9_]`, no
`0x` prefix. All stored and emitted as left-aligned `bytes32` short strings.

## Events

| Event | Parameters (indexed marked *) | Trigger |
| --- | --- | --- |
| `ProfileCreated` | `profileId*, owner*, username*` | `createProfile` (`username` zero when none) |
| `ProfileUpdated` | `profileId*` | every content mutation (heartbeat for cache invalidation) |
| `ProfileDeleted` | `profileId*, owner*, username*` | `deleteProfile` |
| `ProfileTransferInitiated` / `ProfileTransferCancelled` / `ProfileTransferred` | `profileId*, from*, to*` / `profileId*` / `profileId*, from*, to*` | transfer lifecycle |
| `RecoveryAddressSet` | `profileId*, recovery*` | `setRecoveryAddress` |
| `OperatorSet` | `owner*, operator*, approved` | `setOperator` |
| `UsernameChanged` | `profileId*, previousUsername*, username*` | `setUsername` (zero = none) |
| `UsernameReserved` / `UsernameUnreserved` | `username*, claimant*` / `username*` | admin reservations |
| `FieldUpdated` | `profileId*, key*, value` | default-language field set |
| `LocalizedFieldUpdated` | `profileId*, key*, lang*, value` | localized field set |
| `FieldRemoved` | `profileId*, key*, lang*` | removal (explicit or empty value); `lang` zero = default |
| `ItemAdded` / `ItemRemoved` | `profileId*, itemId*, kind*` | every add / remove, typed or generic |
| `ItemAttributeUpdated` / `ItemAttributeRemoved` | `profileId*, itemId*, key*, lang, value` | generic attribute path |
| `WebsiteAdded` / `WebsiteUpdated` / `WebsiteRemoved` | `profileId*, websiteId*, url, title` | typed website functions |
| `ImageAdded` / `ImageUpdated` / `ImageRemoved` | `profileId*, imageId*, uri, category, alt` | typed image functions |
| `SocialAdded` / `SocialUpdated` / `SocialRemoved` | `profileId*, socialId*, platform, handle, url` | typed social functions |
| `ExtensionAdded` / `ExtensionRemoved` | `extensionId*, extension*` | registry |
| `ExtensionApprovalSet` | `profileId*, extensionId*, approved` | owner opt-in |
| `ExtensionFieldUpdated` / `ExtensionFieldRemoved` | `profileId*, extensionId*, key*, lang, value` | extension namespace writes |
| `Upgraded`, `OwnershipTransferStarted`, `OwnershipTransferred`, `Initialized` | (OpenZeppelin) | upgrade / admin |

An indexer reconstructs the full state from these; `test/Profile.test.ts` ("indexer
compatibility") replays a session and diffs it against the lens.

## Errors

Declared at file level in `ProfileErrors.sol`, present in the ABI.

| Error | Trigger |
| --- | --- |
| `ProfileNotFound(profileId)` | id never created or deleted — every id-based read and write |
| `AlreadyHasProfile(account)` | `createProfile` twice; transfer to / accept by an address that owns one |
| `NotAuthorized(profileId, account)` | content write by non-owner/non-operator |
| `NotProfileOwner(profileId, account)` | identity action by non-owner (rename, delete, recovery, extension approval) |
| `NotOwnerOrRecovery(profileId, account)` | transfer initiate/cancel by anyone else |
| `NotPendingOwner(profileId, account)` / `NoPendingTransfer(profileId)` | transfer acceptance / cancellation |
| `ZeroAddress()` / `InvalidAddress(account)` | zero where an address is required / self-transfer, self-operator, self-recovery |
| `InvalidUsername()` / `UsernameTaken(username)` / `UsernameIsReserved(username)` / `UsernameUnchanged(username)` | username rules |
| `InvalidKey()` / `InvalidKind()` / `InvalidLanguage()` / `ValueTooLong(length, max)` | identifier and value validation |
| `ItemNotFound(itemId)` / `ItemKindMismatch(itemId, expected, actual)` | item access / typed function on the wrong kind |
| `ExtensionAlreadyRegistered(id)` / `ExtensionNotRegistered(id)` / `ExtensionNotApproved(profileId, id)` / `InvalidExtension(address)` / `ExtensionIdMismatch(expected, reported)` | registry and handshake |
| `OwnableUnauthorizedAccount`, `InvalidInitialization`, `UUPSUnauthorizedCallContext`, `ERC1967InvalidImplementation`, … | OpenZeppelin |

## Functions

### Classification

- **Profile lifecycle:** `createProfile`, `deleteProfile`, `transferProfile`, `acceptProfile`,
  `cancelTransfer`, `setRecoveryAddress`, `setOperator`
- **Username:** `setUsername`; admin `reserveUsername`, `unreserveUsername`
- **Fields:** `setField`, `setLocalizedField`, `setFields`, `removeField`
- **Items (generic):** `addItem`, `setItemAttribute`, `setItemAttributes`, `removeItem`
- **Items (typed):** `addWebsite`/`updateWebsite`/`removeWebsite`, `addImage`/`updateImage`/`removeImage`,
  `addSocial`/`updateSocial`/`removeSocial`
- **Extensions:** admin `registerExtension`, `unregisterExtension`; owner `approveExtension`;
  extension `setExtensionField`; extension/owner/operator `removeExtensionField`
- **Admin:** `initialize` (once, via proxy constructor), `upgradeToAndCall`, `transferOwnership` / `acceptOwnership`
- **Views (core):** `profileIdOf`, `ownerOf`, `exists`, `pendingOwnerOf`, `recoveryAddressOf`,
  `isOperator`, `isAuthorized`, `profilesCreated`, `getProfileRecord`, `usernameOf`,
  `resolveUsername`, `isUsernameAvailable`, `normalizeUsername`, `usernameReservation`, `getField`,
  `getLocalizedField`, `resolveField`, `resolveFields`, `getItemIds`, `getItemCount`,
  `getItemKind`, `getItemAttribute`, `resolveItemAttribute`, `resolveItemAttributes`,
  `getExtension`, `extensionIdOf`, `getExtensions`, `isExtensionApproved`, `getExtensionField`
- **Views (lens):** `getProfile(address, lang)`, `getProfileById`, `getProfileByUsername`,
  `getFullProfile(address, lang)`, `getFullProfileById`, `getWebsites`/`getWebsite`,
  `getImages`/`getImage`, `getSocials`/`getSocial`, `getItems(pid, kind, lang, keys, offset, limit)`

Every write names the profile by `profileId` (from `profileIdOf(address)`), so operators and smart
accounts can act on a profile without being its address.

---

### createProfile

```solidity
function createProfile(string calldata username, string calldata displayName, string calldata bio, string calldata avatar)
    external returns (uint256 profileId);
```

**Access:** anyone without a profile (`AlreadyHasProfile` otherwise). The caller becomes owner.

**Flow:** allocate `++nextProfileId` → record owner and timestamps → index `profileIdOf` → if
`username` non-empty: normalize, check not taken / not reserved for someone else (a reservation
held by the caller is consumed), index → emit `ProfileCreated` → write each non-empty standard
field (`displayName`, `bio`, `avatar`) as a default-language field, emitting `FieldUpdated` each.

---

### deleteProfile / transferProfile / acceptProfile / cancelTransfer / setRecoveryAddress / setOperator

| Function | Access | Effect |
| --- | --- | --- |
| `deleteProfile(pid)` | owner | releases username and address, deletes the record (id retired; content unreachable, not cleared) |
| `transferProfile(pid, to)` | owner or recovery | `to` non-zero, not the owner, owns no profile; sets `pendingOwner` |
| `acceptProfile(pid)` | pending owner (must own no profile) | re-keys `profileIdOf`, sets owner, clears pending and recovery, bumps `updatedAt` |
| `cancelTransfer(pid)` | owner or recovery | clears `pendingOwner` (`NoPendingTransfer` if none) |
| `setRecoveryAddress(pid, r)` | owner | any address but the owner; zero clears |
| `setOperator(op, approved)` | any account (owner-keyed) | `op` non-zero and not self |

---

### setUsername / reserveUsername / unreserveUsername

```solidity
function setUsername(uint256 profileId, string calldata username) external;          // owner; "" clears
function reserveUsername(string calldata username, address claimant) external;       // admin
function unreserveUsername(string calldata username) external;                       // admin
```

`setUsername` normalizes, reverts `UsernameUnchanged` if the result equals the current name,
claims the new name (taken / reserved checks), releases the old one, emits `UsernameChanged`.
Reservations affect future registrations only; a name currently held is never revoked.

---

### setField / setLocalizedField / setFields / removeField

```solidity
function setField(uint256 profileId, string calldata key, string calldata value) external;
function setLocalizedField(uint256 profileId, string calldata key, string calldata lang, string calldata value) external;
function setFields(uint256 profileId, FieldInput[] calldata fields) external;         // {key, lang, value}[]
function removeField(uint256 profileId, string calldata key, string calldata lang) external;
```

**Access:** owner or operator. Empty `lang` = default; empty `value` = removal (emits
`FieldRemoved`). Values over 4 096 bytes revert `ValueTooLong`. Every call bumps `updatedAt` and
emits `ProfileUpdated` once.

---

### addItem / setItemAttribute / setItemAttributes / removeItem

```solidity
function addItem(uint256 profileId, string calldata kind, FieldInput[] calldata attributes) external returns (uint256 itemId);
function setItemAttribute(uint256 profileId, uint256 itemId, string calldata key, string calldata lang, string calldata value) external;
function setItemAttributes(uint256 profileId, uint256 itemId, FieldInput[] calldata attributes) external;
function removeItem(uint256 profileId, uint256 itemId) external;
```

**Access:** owner or operator. `addItem` allocates `++nextItemId` on the profile, records
`{kind, index}` and appends to the kind's list (`ItemAdded`), then writes each attribute
(`ItemAttributeUpdated`). `removeItem` swap-and-pops the kind list, updates the moved item's
index, deletes the record (`ItemRemoved`); attributes are left orphaned but unreachable (all item
getters check the item is live).

---

### Typed items

```solidity
function addWebsite(uint256 pid, string url, string title) external returns (uint256);
function updateWebsite(uint256 pid, uint256 websiteId, string url, string title) external;
function removeWebsite(uint256 pid, uint256 websiteId) external;
function addImage(uint256 pid, string uri, string category, string alt) external returns (uint256);
function updateImage(uint256 pid, uint256 imageId, string uri, string category, string alt) external;
function removeImage(uint256 pid, uint256 imageId) external;
function addSocial(uint256 pid, string platform, string handle, string url) external returns (uint256);
function updateSocial(uint256 pid, uint256 socialId, string platform, string handle, string url) external;
function removeSocial(uint256 pid, uint256 socialId) external;
```

Sugar over the generic path: kind `website` / `image` / `social`, default-language attributes
`url,title` / `uri,category,alt` / `platform,handle,url`. Adds emit `ItemAdded` + the typed event;
updates emit the typed event; removes emit `ItemRemoved` + the typed event. Update/remove revert
`ItemKindMismatch` on the wrong kind. Localized titles/alt text go through `setItemAttribute`.

---

### Extensions

```solidity
function registerExtension(string calldata extensionId, address extension) external;          // admin
function unregisterExtension(string calldata extensionId) external;                           // admin
function approveExtension(uint256 profileId, string calldata extensionId, bool approved) external;   // owner
function setExtensionField(uint256 profileId, string calldata key, string calldata lang, string calldata value) external; // registered + approved extension
function removeExtensionField(uint256 profileId, string calldata extensionId, string calldata key, string calldata lang) external; // that extension, owner, or operator
```

`registerExtension` requires: non-zero address, id and address both unused, ERC-165 support for
`IProfileExtension`, `extensionId() == id`, `profileRegistry() == address(this)`. These are the
only external calls the core ever makes, all `view`, before any state write.
`setExtensionField` resolves the extension id from `msg.sender`, requires the profile to exist
and the owner's approval, then writes into `extensionFields[pid][id]` (empty value removes).

---

### Views

Core views are primitive and batchable: `resolveFields(pid, keys[], lang)` and
`resolveItemAttributes(pid, itemId, keys[], lang)` return several values with default-language
fallback in one call; `getProfileRecord(pid)` returns ownership and bookkeeping. Id-based views
revert `ProfileNotFound` for dead ids and `ItemNotFound` for retired items, so no stale content
leaks. `getProfileRecord`, `getField`, etc. are what the lens composes into `ProfileView`,
`FullProfileView`, `Website[]`, `Image[]`, `Social[]` and paged `ItemView[]` (`{id, attributes[]}`).

---

## Security Model

- **Authorization tiers:** `_requireAuthorized` (owner or operator: content), `_requireOwner`
  (identity: rename, delete, recovery, extension approval), `_requireOwnerOrRecovery` (transfer
  initiate/cancel). All re-read `owner` from storage; `msg.sender` only.
- **Admin cannot touch content.** The contract owner's powers are `upgradeToAndCall`, the
  extension registry and username reservations. Tests assert every content/identity function
  rejects the admin.
- **No value, no reentrancy surface:** no `receive`/`fallback` (the proxy rejects plain value),
  no token movement, no external calls in user paths.
- **Upgrade safety:** implementation locked with `_disableInitializers`; `onlyProxy`;
  `proxiableUUID` check; ERC-7201 namespaces (append-only `Layout`); two-step admin ownership.
- **Extensions** write only into their own namespace, only after per-profile owner approval, and
  are never called by the core (no hooks → no DoS, no reentrancy via extension).
- **Identifiers** are ASCII with case folding; no Unicode confusables. Values are opaque bytes:
  frontends must escape them and validate URL schemes. Nothing on-chain dereferences a URL/CID.
- **Bounded work:** no loop over user-controlled sets in write paths except the caller's own batch
  arrays; deletion and removal are O(1) by retiring ids.
- **Not audited.** Put the owner behind a multisig before real users depend on the registry.

## Gas Notes

From `npm run gas:profile` (viaIR, 200 runs): create with username 147k; with three fields 208k;
short field 63k cold / 46k warm; localized field 64k; website 176k first / 125k next; image 184k;
social 183k; generic item with two attributes 217k; username change 70k; accept transfer 64k;
delete 45k. Strings dominate (20k per fresh slot); key derivation and validation are ~1–2k. See
the README for the full table and the packing decisions behind it.

## Deployment

`ignition/modules/profile.ts` (`npm run deploy:nurachain:profile`) deploys `NuraProfile`,
`NuraProfileProxy` initialized with `owner`, `NuraProfileLens` and `SocialVerifier`;
`scripts/profile-setup.ts` registers the verifier (owner action);
`scripts/profile-upgrade.ts` performs and verifies a UUPS upgrade. Parameters: `owner`,
`verifierAdmin`, `verifierSigner` (all default to the deployer).
