# Nura Profile — a decentralized, extensible identity primitive

`contracts/profile` is the on-chain profile system for the Nura ecosystem (Nura Wallet, Nura
Social, Nura Identity, and whatever comes next). One profile per address, a global username
namespace, localizable fields, unlimited websites / images / socials, and a way for future
applications to attach new kinds of data — without redeploying, and without asking the core
contract's permission.

The design principle everything else follows from: **the core must not become obsolete when a
profile feature is added.** So the core stores no schema. It stores values addressed by
`(profile, key, language)` and list items that are bags of such values under a free-form
`kind`. "Add a Discord field" is a key. "Add an NFT showcase" is a kind. "Add GitHub
verification" is an extension contract writing into its own namespace. None of them touch
`NuraProfile.sol`.

```text
                    writes (owner / operator)              reads (wallets, dapps, indexers)
                              │                                           │
                              ▼                                           ▼
   ┌────────────────────────────────────────────┐        ┌────────────────────────────────┐
   │ NuraProfileProxy  (ERC-1967, never changes) │        │ NuraProfileLens  (stateless)    │
   │   └─ delegates to ─▶ NuraProfile  (UUPS)    │◀───────│   getProfile(address, lang)     │
   │        profiles · usernames · fields ·      │  view  │   getFullProfile · getWebsites  │
   │        items · operators · extensions       │  calls │   getImages · getSocials        │
   └────────────────────────────────────────────┘        │   getItems(kind, keys, page)    │
                 ▲ setExtensionField (own namespace)      └────────────────────────────────┘
                 │ after the owner approved the extension
   ┌─────────────┴──────────────┐   ┌──────────────────────┐   ┌──────────────────────┐
   │ SocialVerifier (reference) │   │ future: Achievements │   │ future: DAO, Wallets… │
   └────────────────────────────┘   └──────────────────────┘   └──────────────────────┘
```

---

## 1. Architecture

| File | Role |
| --- | --- |
| `NuraProfile.sol` | The core. UUPS-upgradeable, ERC-7201 namespaced storage. Owns every rule: who may write, what a valid username/key/language is, how items and extensions work. Exposes primitive, batchable reads. |
| `NuraProfileProxy.sol` | OpenZeppelin `ERC1967Proxy` under a project-local name so Hardhat/Ignition can deploy and verify it. **This is the address everyone uses.** |
| `NuraProfileLens.sol` | Stateless read model: turns the core's primitives into the structs a UI renders. Redeployable at will; nothing depends on its address. |
| `interfaces/INuraProfile.sol` | Full external surface + every event. The ABI consumers code against. |
| `interfaces/IProfileExtension.sol` | Handshake an extension must pass to be registered (`extensionId`, `profileRegistry`, ERC-165). |
| `ProfileTypes.sol` | Shared structs: `FieldInput`, `ProfileRecordView`, `ProfileView`, `Website`, `Image`, `Social`, `ItemView`, `FullProfileView`. |
| `ProfileErrors.sol` | File-level custom errors, shared by the core and its library so one set appears in the ABI. |
| `libraries/ProfileKeys.sol` | The well-known keys and kinds (`displayName`, `bio`, `website`, `url`, …). Conventions, not schema. |
| `libraries/ProfileStrings.sol` | Validation + packing of keys, kinds, language tags and usernames into `bytes32` short strings. |
| `extensions/SocialVerifier.sol` | Reference extension: EIP-712-attested "this profile owns handle X on platform Y". |
| `mocks/ProfileMocks.sol` | Test doubles: configurable extension, non-extension, a V2 implementation. |
| `test/ProfileFuzz.t.sol`, `test/ProfileInvariant.t.sol` | Solidity property and invariant tests (Hardhat 3 native runner). |

### Why UUPS + extensions, not Diamond

The requirement is that new *capabilities* can be added later. Two things deliver that here
without a Diamond's routing table and storage-collision surface:

1. **Generic storage.** New fields and new item kinds need no code at all.
2. **Sidecar extensions.** New *logic* (verification, reputation, achievements) lives in its own
   contract with its own storage, reads the core through `INuraProfile`, and — once the profile
   owner opts in — writes attested values into its own namespace on the core. The core never
   `delegatecall`s into an extension and never calls one during a user action, so a broken or
   malicious extension cannot corrupt core storage or block a user's transaction.

UUPS remains for the case the schema *rules* themselves need to change (say, a new username
alphabet). It is the simplest upgrade pattern that fits, the admin surface is one `onlyOwner`
function, and the implementation is locked (`_disableInitializers`) so only the proxy is live.

### Why the read model is a separate contract

Nurachain enforces EIP-170 at exactly 24 576 bytes. With every struct projection compiled into
the core, the legacy pipeline lands at ~30 KB; even under `viaIR` it barely fits and leaves no
room for a V2. Moving projections into the lens makes the core **21 502 bytes with ~3.0 KB of
headroom**, shrinks the upgradeable (and therefore auditable) surface to state + rules, and means
a new item kind can get a typed getter by redeploying a 7 KB stateless contract instead of
upgrading the registry. Wallets talk to two addresses: the proxy for writes and primitive reads,
the lens for rich reads. Both are in `web/application/src/config/contracts.ts`.

---

## 2. Data model

```text
Profile #id  (ids start at 1, never reused)
├── owner            address           one profile per address; profileIdOf(owner) → id
├── username         bytes32           lower-cased, globally unique, optional
├── createdAt / updatedAt               uint40 timestamps (updatedAt bumps on every content write)
├── pendingOwner     address           two-step transfer in flight
├── recovery         address           may initiate a transfer if the owner key is lost
├── fields           key → lang → string          setField / setLocalizedField / setFields
├── items            itemId → { kind, index }     ids per profile, sequential, never reused
│     └── attributes itemId → key → lang → string  addItem / setItemAttribute(s)
│     └── per-kind id lists  kind → uint32[]        getItemIds(kind), swap-and-pop on remove
└── extension fields extensionId → key → lang → string   written only by that extension
```

All of it lives in one struct at the ERC-7201 slot
`erc7201:nura.storage.NuraProfile` (`0x2fd3cb39…3300`, pinned by a test). Operators are keyed
by owner address (`operators[owner][operator]`), exactly like ERC-721 `setApprovalForAll`, so
they neither follow a profile to a new owner nor need clearing on transfer.

### Identifiers: strings in, `bytes32` short strings inside

Keys, kinds, language tags and usernames are passed as `string` — that is what frontends and the
admin UI want to type — and validated into left-aligned, zero-padded `bytes32` values
(`ProfileStrings`). The packed form is what storage is keyed by and what events carry, which
gives three things at once: one-word mapping keys, filterable event topics, and values that are
readable in a block explorer without a lookup table (`0x62696f00…` is `"bio"`).

| Identifier | Rule | Notes |
| --- | --- | --- |
| field / attribute key | 1..32 bytes, printable non-space ASCII (0x21..0x7E) | case preserved (developer identifiers); convention lowerCamelCase, reverse-DNS for app-specific keys (`social.nura.badges`) |
| item kind | 1..28 bytes, same alphabet | 28 so the kind shares one slot with the item's list index |
| language tag | empty = default; else 1..32 bytes of `[A-Za-z0-9-]`, **lower-cased** | BCP-47 is case-insensitive: `pt-BR` and `pt-br` are one value |
| username | 3..32 bytes; ASCII letters lower-cased; then only `[a-z0-9_]`; may not start with `0x` | so a handle can never be mistaken for an address |
| value | ≤ 4096 bytes | any UTF-8; empty value = remove |

### Why `mapping(profile => key => lang => string)` and not a struct

The question posed was `mapping(bytes32 => string)` versus `mapping(bytes32 => mapping(bytes32
=> string))`. The answer is the second, keyed by profile first, for these reasons:

- **Localization is orthogonal to the field.** A nested `lang` level makes *every* field
  localizable with no per-field decision, including fields nobody has invented yet. Flattening
  (`bio_en`) would bake language into keys and make "all values of `bio`" unenumerable.
- **Default + fallback is one extra read.** `_resolve(byLang, lang)` reads `byLang[lang]`, then
  `byLang[0]`. Reads of the default language cost exactly one lookup.
- **Gas is the same as a flat map.** Each extra mapping level is one `keccak256` of two words
  (~50 gas); the cost of a field write is the string's storage, not the key derivation.
- **A struct of named fields is the thing that becomes obsolete.** Adding a member to a storage
  struct in an upgradeable contract is a migration; adding a key to a mapping is a transaction.

Standard fields (`displayName`, `bio`, `avatar`, `cover`, `location`, `jobTitle`, `company`) are
just well-known keys (`ProfileKeys`). `createProfile` writes three of them; the lens projects
all seven into `ProfileView`. Nothing in the core treats them specially.

### Items: a free-form `kind` and a bag of attributes

A website, an image, a social account, a linked wallet, a credential, an NFT showcase entry — all
are "an item of some kind with some attributes". So that is the primitive:

```solidity
uint256 itemId = profile.addItem(id, "wallet", [
    FieldInput("chain",   "",   "bitcoin"),
    FieldInput("address", "",   "bc1q…"),
    FieldInput("label",   "en", "Cold storage"),
    FieldInput("label",   "fa", "کیف پول سرد")
]);
```

Item ids are per profile, sequential, and never reused, so a removed item's orphaned attributes
are unreachable through the API (every item getter checks the item is live) and an indexer can
treat `(profileId, itemId)` as a stable key forever. Each kind keeps an ordered `uint32[]` of
live ids; removal is swap-and-pop, so **list order is insertion order until a removal moves the
last item into the gap** — an indexer must mirror that (the test suite does) or treat lists as
sets. Order that matters to a UI should be an attribute (`"order"`), not the list position.

`ItemRecord` packs `bytes28 kind` + `uint32 index` into one slot, so an item costs one slot of
bookkeeping plus one list element plus its attributes.

---

## 3. Multilingual system

Every field and every item attribute has a default value (language `""`) and any number of
localized values. There is no list of supported languages; a tag is valid if it matches the
alphabet, so `"en"`, `"fa"`, `"zh-hant"`, `"pt-br"` and `"x-klingon"` all work today.

```solidity
profile.setField(id, "bio", "Blockchain developer building Nura Chain");          // default
profile.setLocalizedField(id, "bio", "fa", "توسعه‌دهنده بلاکچین و سازنده Nura Chain");
profile.setLocalizedField(id, "bio", "de", "Blockchain-Entwickler");

profile.getLocalizedField(id, "bio", "de");   // "Blockchain-Entwickler"   (exact, no fallback)
profile.getLocalizedField(id, "bio", "fr");   // ""                        (exact, unset)
profile.resolveField(id, "bio", "fr");        // "Blockchain developer…"   (falls back to default)
lens.getProfile(owner, "fa");                 // every standard field resolved in fa with fallback
```

The same mechanism, unchanged, localizes website titles (`setItemAttribute(id, websiteId,
"title", "fa", …)`), image alt text, custom fields, and any attribute an extension writes.
Frontends should render in the viewer's language via `resolve*` and offer editors the exact
values via `get*`. Discovering *which* languages a profile has is an indexer question — or one
`eth_getLogs` for `LocalizedFieldUpdated` filtered by the profile id topic — not a storage loop.

Only ASCII case is folded. Unicode normalization is not attempted on-chain; it is neither cheap
nor well-defined there, and rejecting the input beats guessing at it.

---

## 4. Custom fields

Any application may define keys without touching the contract:

```solidity
profile.setField(id, "discord", "alice#1234");
profile.setField(id, "birthday", "1990-05-01");
profile.setLocalizedField(id, "education", "en", "MSc Computer Science, Sharif");
profile.setFields(id, batch);                          // many (key, lang, value) in one tx
profile.removeField(id, "discord", "");                // or setField(id, "discord", "")
```

Conventions the ecosystem should agree on (enforced by nobody, which is the point):

- lowerCamelCase for keys shared across apps; reverse-DNS for app-private keys
  (`social.nura.badgeCount`), ≤ 32 bytes.
- Values are display strings or URIs. Structured data goes off-chain (IPFS/Arweave JSON), and the
  field holds the CID.
- Empty means absent. There is no "set to empty string" distinct from removal.

Values written by the owner and values written by an extension live in different namespaces
(`getField` vs `getExtensionField`), so an app can trust an extension-namespaced value to have
been written by that extension and nobody else.

---

## 5. Websites

Unlimited. An item of kind `website` with attributes `url`, `title` (localizable) and
`description` (localizable, optional). Anything else you want on a website (an `icon`, a
`category`) is another attribute.

```solidity
uint256 w = profile.addWebsite(id, "https://nurachain.net", "Nura Chain");
profile.setItemAttribute(id, w, "title", "fa", "نورا چین");
profile.setItemAttribute(id, w, "description", "", "The chain");
profile.updateWebsite(id, w, "https://nurachain.net/", "Nura");
profile.removeWebsite(id, w);

lens.getWebsites(id, "fa");      // Website[] { id, url, title, description } with fallback
lens.getWebsite(id, w, "fa");
```

`removeWebsite` checks the item really is a website (`ItemKindMismatch` otherwise), so the typed
events stay truthful. Every typed function also emits the generic `ItemAdded` / `ItemRemoved`,
so an indexer can maintain item lists from one event pair.

---

## 6. Images

Kind `image`; attributes `uri`, `category` (free-form: `avatar`, `cover`, `gallery`, `banner`,
`portfolio`, …) and `alt` (localizable). The image itself is never on-chain — `uri` is an
`ipfs://`, `ar://` or `https://` reference, and the 4 096-byte value cap makes inlining
impractical by design. The profile's *active* avatar and cover are the standard fields `avatar`
and `cover`; the image collection is the gallery.

```solidity
uint256 im = profile.addImage(id, "ipfs://bafy…", "gallery", "Talk at ETHGlobal");
profile.setItemAttribute(id, im, "alt", "de", "Vortrag bei ETHGlobal");
profile.updateImage(id, im, "ipfs://bafy…", "portfolio", "Talk");
profile.removeImage(id, im);
lens.getImages(id, "de");
```

---

## 7. Socials

Kind `social`; attributes `platform`, `handle`, `url`. Platforms are strings, so `lens`,
`farcaster`, `discord`, `linkedin` or a network that does not exist yet all work without a
contract change. Frontends own the platform vocabulary and the URL templates.

```solidity
uint256 s = profile.addSocial(id, "farcaster", "alice", "https://warpcast.com/alice");
profile.updateSocial(id, s, "farcaster", "alice.eth", "https://warpcast.com/alice.eth");
profile.removeSocial(id, s);
lens.getSocials(id, "");
```

Whether a social entry is *verified* is not the core's business — that is what the
`SocialVerifier` extension attests, in its own namespace, and what a wallet checks before it
draws a badge (`verifier.verifiedHandle(id, "farcaster") == social.handle`).

---

## 8. Extensions

An extension is a separate contract that:

1. implements `IProfileExtension` (ERC-165, `extensionId()`, `profileRegistry()`);
2. is registered by the core's admin under that id (`registerExtension`), which checks all three
   so an extension built for another deployment cannot be registered by mistake;
3. is approved per profile by that profile's **owner** (`approveExtension(id, "ext", true)`);
4. may then call `setExtensionField(profileId, key, lang, value)`, which lands in
   `extensionFields[profileId][extensionId]` — its namespace and nobody else's.

Everything else an extension does — its own storage, its own logic, its own events — is its own
affair. The core imposes no interface beyond the handshake and never calls an extension during a
user action (no `onTransfer` hooks): a hook is a way for one broken extension to block every
user's transaction, and a way for a malicious one to run code in a user's call.

Permissions, exhaustively:

| Who | Can |
| --- | --- |
| admin (contract owner) | register / unregister extensions; nothing about which profiles use them |
| profile owner | approve / revoke an extension for their profile; remove any extension field from their profile |
| operator | remove extension fields (content editing), not approve |
| the extension | write / remove fields in its own namespace on profiles that approved it |
| another extension | nothing in this namespace |

Unregistering an extension stops its writes; its existing fields stay readable (a UI decides how
to treat data under a namespace that is no longer registered). Revoking approval does the same for
one profile.

### Reference: `SocialVerifier`

A backend with `VERIFIER_ROLE` completes the platform's OAuth, then signs an EIP-712
`VerifyHandle(profileId, platform, handle, nonce, deadline)`. The owner (or an operator) submits
it; the extension checks the signer, the deadline and the per-profile nonce, then writes `handle`
under key `platform`. Revocation is a verifier action; the owner can also clear it. This is the
shape of the "GitHub verification" from the wish list, and it needed zero changes to the core.

### Writing your own

```solidity
contract Achievements is IProfileExtension, ERC165 {
    INuraProfile public immutable registry;
    bytes32 public constant EXTENSION_ID = "achievements";
    mapping(uint256 profileId => bytes32[] earned) private _earned;    // own storage

    function extensionId() external pure returns (bytes32) { return EXTENSION_ID; }
    function profileRegistry() external view returns (address) { return address(registry); }
    function supportsInterface(bytes4 id) public view override returns (bool) {
        return id == type(IProfileExtension).interfaceId || super.supportsInterface(id);
    }

    function award(uint256 profileId, string calldata badge, string calldata metadataURI) external onlyIssuer {
        _earned[profileId].push(ProfileStrings.toKey(badge));
        // mirrors into the core so wallets and indexers see it without knowing this contract:
        registry.setExtensionField(profileId, badge, "", metadataURI);
    }
}
```

---

## 9. Username system

- **Unique and normalized.** `Alice`, `ALICE` and `alice` are one name. Registration, lookup,
  availability and change all go through the same normalization; the fuzz suite asserts any two
  spellings that fold to the same bytes collide.
- **Lookup both ways.** `resolveUsername("Alice") → (profileId, owner)`; `usernameOf(id)`;
  `lens.getProfileByUsername("alice", "fa")`.
- **Optional.** A profile may have no username (`createProfile("", …)`) and set one later.
- **Change and release.** `setUsername(id, "new")` releases the old name immediately. Setting the
  empty string clears. Deleting the profile releases it. No cooldown: a name is the owner's to
  keep or give up, and squatting a released name is bounded by the fact that it costs a profile
  slot (one per address) and gas.
- **Reservations.** The admin may reserve a name for a specific claimant (only they can register
  it; the reservation is consumed when they do) or for nobody (blocked). Reserve brand and system
  names *before launch*. A reservation on a name that is currently held affects only its future:
  there is deliberately no admin power to take a username away from a user. Impersonation is
  handled the decentralized way — verification badges via extensions — not by revocation.
- **Rules:** 3..32 bytes after lower-casing, `[a-z0-9_]`, not starting with `0x`.

---

## 10. Ownership, operators, transfer, recovery, deletion

| Action | Owner | Operator | Recovery address | Admin |
| --- | --- | --- | --- | --- |
| edit fields / items / attributes | ✔ | ✔ | ✖ | ✖ |
| remove an extension's field from my profile | ✔ | ✔ | ✖ | ✖ |
| set username, approve extensions, set recovery, set operators | ✔ | ✖ | ✖ | ✖ |
| initiate / cancel transfer | ✔ | ✖ | ✔ | ✖ |
| accept transfer | pending owner only | | | |
| delete profile | ✔ | ✖ | ✖ | ✖ |
| upgrade, register extensions, reserve usernames | ✖ | ✖ | ✖ | ✔ |

- **Operators** (`setOperator(op, true)`) are keyed by owner and cover every profile that owner
  holds: session keys, a smart account's module, or an app the user trusts to edit for them.
  They cannot do anything identity-level.
- **Transfer is two-step**: `transferProfile(id, to)` then `acceptProfile(id)` from `to`, who
  must not already own a profile. A typo in `to` therefore costs nothing; `cancelTransfer`
  withdraws the offer. On accept, the owner index is re-keyed, the pending owner is cleared and
  the **recovery address is cleared** (it was the previous owner's choice).
- **Recovery** (`setRecoveryAddress`) designates one address — a second wallet, a multisig, a
  social-recovery contract — that may *initiate* a transfer if the owner key is lost. It cannot
  edit, rename, delete or accept. Because the recipient must still accept, a compromised recovery
  address cannot move the profile to a dead address, only offer it.
- **Deletion** releases the username and the address, and retires the id. Field and item strings
  are not cleared: their number is unbounded, so clearing them would be an unbounded loop, and
  since the id is never reused and every id-based getter reverts with `ProfileNotFound`, they are
  unreachable. Indexers drop the profile on `ProfileDeleted`.
- **Admin has no path to content.** The suite asserts every content and identity function
  rejects the contract owner. The admin's powers are upgrade (UUPS, `onlyOwner`, two-step
  ownership), the extension registry, and username reservations.

---

## 11. Upgradeability

- **UUPS** (`UUPSUpgradeable`, `_authorizeUpgrade` = `onlyOwner`) behind `NuraProfileProxy`
  (`ERC1967Proxy`). `initialize(owner)` runs inside the proxy constructor, so there is no
  uninitialized window. The implementation's constructor calls `_disableInitializers()`.
- **Storage** is one ERC-7201 namespaced struct (`Layout`). OpenZeppelin's own modules use their
  own namespaces. Rules for a V2: only **append** to `Layout`; never reorder, remove or retype a
  member; put brand-new state in a new namespace (see `NuraProfileV2Mock`); use `reinitializer(n)`
  for one-time migration logic and pass it as the `upgradeToAndCall` data.
- **Admin ownership is two-step** (`Ownable2StepUpgradeable`), so a mistyped `transferOwnership`
  cannot brick the upgrade path. Put the owner behind a multisig before real users depend on it.
- `scripts/profile-upgrade.ts` checks the signer is the owner, deploys or takes the candidate,
  verifies `proxiableUUID` and the EIP-170 size, upgrades, and reads the slot back. The test suite
  upgrades to a V2 mock and checks every V1 profile, field, item, username and the admin survive.
- `VERSION()` on the implementation is the post-upgrade sanity check.

---

## 12. Gas considerations

Measured with `npm run gas:profile` (solc 0.8.28, viaIR, optimizer 200 runs, cancun):

| Operation | Gas | Notes |
| --- | ---: | --- |
| deploy NuraProfile (implementation) | 4,729,332 | 21 502 bytes of runtime code |
| deploy NuraProfileProxy + initialize | 169,973 | one-time |
| deploy NuraProfileLens | 1,585,213 | 7 087 bytes of runtime code |
| createProfile(username only) | 147,265 | record + username index |
| createProfile(username, displayName, bio, avatar) | 207,759 | + 3 short fields |
| setField(short, cold) | 63,378 | new key, 1 slot |
| setField(short, warm) | 46,314 | overwrite |
| setField(240-byte bio, cold) | 246,081 | 8 data slots + length |
| setLocalizedField(fa bio, cold) | 132,236 | 60 bytes UTF-8 (2 slots) |
| setLocalizedField(de bio, cold) | 64,366 | second language |
| setFields(3 fields, cold) | 125,705 | batch |
| removeField | 67,817 | refund applied |
| addWebsite(url, title) | 175,954 | item + 2 attributes + first list slot |
| addWebsite (second) | 124,690 | list exists |
| setItemAttribute(website title, fa) | 66,722 | localized attribute |
| updateWebsite | 52,191 | overwrite url + title |
| addImage(uri, category, alt) | 183,752 | item + 3 attributes |
| addSocial(platform, handle, url) | 182,820 | item + 3 attributes |
| addItem(generic wallet, 2 attrs) | 217,350 | generic path, one event per attribute |
| removeWebsite (swap-and-pop) | 54,321 | |
| setUsername (change) | 70,210 | release old + claim new |
| setOperator | 51,332 | |
| setRecoveryAddress | 53,751 | |
| transferProfile (initiate) | 38,918 | |
| acceptProfile | 64,142 | re-key owner index |
| deleteProfile | 45,479 | refunds |

Where the design spends and saves:

- **Strings dominate.** Every write is 20k per fresh 32-byte slot; key derivation and validation
  are ~1–2k. Values ≤ 31 bytes fit one slot. The 4 096-byte cap is storage hygiene, not gas
  protection: the writer pays either way.
- **`bytes32` short strings** for keys/kinds/langs/usernames: one word, no hash table, readable.
- **Packing**: `ProfileRecord` puts `owner` + both timestamps in one slot, so the `updatedAt`
  bump on each write hits a slot the authorization check already warmed (~2.9k). `ItemRecord`
  packs kind + index into one slot. Per-kind id lists are `uint32[]` (8 per slot).
- **Calldata, not memory.** Values are stored straight from `string calldata`; only the ≤ 32-byte
  identifiers are copied to memory for validation.
- **Batches** (`setFields`, `setItemAttributes`, `addItem` with attributes) amortize the 21k base
  cost and the authorization read.
- **Events**: typed functions emit one typed event carrying their payload plus the small generic
  `ItemAdded`/`ItemRemoved`, rather than one generic event per attribute. `ProfileUpdated` is a
  deliberate ~1.1k heartbeat per write so a wallet can invalidate a cache with one subscription.
- **Deletion and removal retire ids** instead of clearing unbounded strings (see §10).
- **Custom errors** everywhere; no revert strings.
- **No `updatedAt` per field**: block timestamps come free with events.

---

## 13. Security model

Reviewed against the checklist in the brief. Findings and how each is handled:

| Concern | Status |
| --- | --- |
| Reentrancy | No native-coin handling (no `receive`/`fallback`; the proxy rejects value), no token transfers, no external calls in user paths. The only outgoing calls are the ERC-165 handshake in the admin-only `registerExtension`, all `view`, made before state is written. |
| Authorization bypass | Three tiers (`_requireAuthorized`, `_requireOwner`, `_requireOwnerOrRecovery`) each re-read `owner` from storage; `msg.sender`-based (no `tx.origin`). Operators are owner-keyed and cannot reach identity actions. Tests cover every function from every wrong caller, including the admin. |
| Storage collisions / upgrade attacks | ERC-7201 namespace for all core state (slot pinned by test); OZ modules namespaced; implementation locked; `onlyProxy` on `upgradeToAndCall`; `proxiableUUID` checked on upgrade; owner two-step. Remaining risk is the owner key — put it behind a multisig. |
| Username squatting | Names cost a profile slot (one per address) and gas; reservations for brand/system names; verification badges via extensions rather than revocation. A username can never look like an address (`0x` prefix rejected). |
| Invalid UTF-8 / homoglyphs | Usernames and language tags are ASCII-only with case folding — no Unicode confusables in identifiers. Values are opaque bytes: the contract makes no UTF-8 assumption, and frontends must escape/sanitize before rendering. |
| Malicious URLs | URLs, CIDs and handles are data. Nothing on-chain fetches them. Frontends must validate schemes (`https:`, `ipfs:`, `ar:`) and never treat a stored string as trusted markup. |
| Array manipulation | Per-kind lists use swap-and-pop with an index stored on the item; invariant tests assert lists equal the live set after random add/remove sequences, ids are unique and never reused. Extension registry uses the same pattern. |
| Griefing / DoS / unbounded loops | No loop over user-controlled sets in write paths except the caller's own batch arrays (they pay). Deletion is O(1). Lists are unbounded by design (the brief forbids caps), so bulk *reads* of a huge profile can exceed an RPC's `eth_call` budget — use the paged `getItems` or the core's per-item getters; nobody but the owner can grow their own lists. Extension writes require owner opt-in, so an extension cannot spam profiles. |
| Extension permission abuse | Extensions write only into `extensionFields[pid][theirId]`; never into owner fields, never into another extension's namespace; only after approval; never called by the core. Owner can revoke and delete; admin can unregister. Registration handshake prevents id/address/registry mismatches. |
| Front-running | Username registration is first-come; a mempool front-runner can take a name you were about to register (as on every chain). Reservations to a specific claimant are immune. Profile transfer is two-step, so a recipient cannot be tricked into accepting the wrong id. |
| Signature replay (verifier) | EIP-712 domain (chain + verifier address), per-profile nonce, deadline; owner/operator-only submission. |
| Centralization | Admin cannot read, write, rename, transfer or delete any profile. Documented in code and enforced by tests. |

Not audited. Treat the owner key as production-critical.

---

## 14. Frontend integration

Two addresses: **proxy** (writes + primitive reads, ABI = `NuraProfile`) and **lens** (rich reads).
Both are registered in the admin panel (`web/application/src/config/contracts.ts`, category
*Identity*); the ABIs are extracted by `node web/application/scripts/extract-abi.mjs`.

### viem

```ts
import { createPublicClient, createWalletClient, http, custom, stringToHex, hexToString } from "viem";
import NuraProfileAbi from "./abi/NuraProfile.json";
import NuraProfileLensAbi from "./abi/NuraProfileLens.json";

const PROFILE = "0x…proxy…";
const LENS = "0x…lens…";
const pub = createPublicClient({ chain: nura, transport: http() });
const wallet = createWalletClient({ chain: nura, transport: custom(window.ethereum) });

// read: one call renders a profile card in the viewer's language, with fallback
const full = await pub.readContract({
  address: LENS, abi: NuraProfileLensAbi, functionName: "getFullProfile", args: [account, navigator.language.slice(0, 2)],
});
if (full.profile.id === 0n) { /* no profile yet */ }
full.websites.forEach((w) => console.log(w.title, w.url));

// write: create, then a batch of localized fields
const [me] = await wallet.getAddresses();
await wallet.writeContract({ address: PROFILE, abi: NuraProfileAbi, functionName: "createProfile",
  args: ["alice", "Alice Doe", "Builder", "ipfs://bafy…avatar"], account: me });
const id = await pub.readContract({ address: PROFILE, abi: NuraProfileAbi, functionName: "profileIdOf", args: [me] });
await wallet.writeContract({ address: PROFILE, abi: NuraProfileAbi, functionName: "setFields", account: me,
  args: [id, [
    { key: "bio", lang: "fa", value: "توسعه‌دهنده بلاکچین" },
    { key: "jobTitle", lang: "", value: "Blockchain Developer" },
    { key: "company", lang: "", value: "Nura Chain" },
  ]] });
await wallet.writeContract({ address: PROFILE, abi: NuraProfileAbi, functionName: "addSocial", account: me,
  args: [id, "github", "alice-dev", "https://github.com/alice-dev"] });

// username → profile
const view = await pub.readContract({ address: LENS, abi: NuraProfileLensAbi, functionName: "getProfileByUsername", args: ["Alice", "en"] });

// events: keys and langs arrive as bytes32 short strings
const keyTopic = stringToHex("bio", { size: 32 });          // filter LocalizedFieldUpdated by key
const readable = hexToString(log.args.lang, { size: 32 });  // "fa"
```

### ethers v6

```ts
const profile = new Contract(PROFILE, NuraProfileAbi, signer);
const lens = new Contract(LENS, NuraProfileLensAbi, provider);

const id = await profile.profileIdOf(await signer.getAddress());
await profile.addWebsite(id, "https://nurachain.net", "Nura Chain");
await profile.setItemAttribute(id, 1n, "title", "fa", "نورا چین");
const websites = await lens.getWebsites(id, "fa");
const [page, total] = await lens.getItems(id, "wallet", "en", ["chain", "address", "label"], 0, 20);
page.forEach((item) => console.log(item.id, item.attributes /* string[] in key order */));
```

### Indexing

Every event carries `uint256 indexed profileId`, so a single `eth_getLogs` on the proxy, filtered
by profile id, reconstructs one profile without an indexer; a full indexer follows the rules
below (the suite replays a session this way and diffs it against the lens):

| Event | Effect on the model |
| --- | --- |
| `ProfileCreated(id, owner, username)` / `ProfileDeleted` / `ProfileTransferred(id, from, to)` | create / drop / re-key the profile |
| `UsernameChanged(id, old, new)` | zero on either side = none |
| `FieldUpdated(id, key, value)` / `LocalizedFieldUpdated(id, key, lang, value)` / `FieldRemoved(id, key, lang)` | fields; `lang` zero = default |
| `ItemAdded(id, itemId, kind)` / `ItemRemoved(id, itemId, kind)` | append / swap-and-pop the kind's list |
| `ItemAttributeUpdated(id, itemId, key, lang, value)` / `ItemAttributeRemoved` | attributes (generic path) |
| `WebsiteAdded/Updated(id, itemId, url, title)` | set attributes `url`, `title` (default lang) |
| `ImageAdded/Updated(id, itemId, uri, category, alt)` | set `uri`, `category`, `alt` |
| `SocialAdded/Updated(id, itemId, platform, handle, url)` | set `platform`, `handle`, `url` |
| `Website/Image/SocialRemoved` | redundant with `ItemRemoved`; convenience |
| `ExtensionFieldUpdated(id, extId, key, lang, value)` / `ExtensionFieldRemoved` | extension namespaces |
| `ExtensionAdded/Removed`, `ExtensionApprovalSet`, `OperatorSet`, `RecoveryAddressSet`, `UsernameReserved/Unreserved` | registry and permissions |
| `ProfileUpdated(id)` | heartbeat: emitted on every content write, for cache invalidation |

Decode `bytes32` identifiers with `hexToString(x, { size: 32 })` (viem) or
`decodeBytes32String` (ethers).

### Rendering rules

- Treat every string as untrusted text. Escape it. Validate URL schemes before linking. Never
  inject stored strings as HTML.
- Use `resolve*` / the lens for display (fallback), `get*` for editors (exact values).
- A verified badge is `verifier.verifiedHandle(id, platform) === social.handle`, not a field.

---

## 15. Deployment

```bash
# 1. sanity-check the chain, the deployer balance and that this bytecode runs there
npm run preflight:nurachain

# 2. deploy implementation + proxy (initialized) + lens + verifier
npm run deploy:nurachain:profile
#    with parameters:  npx hardhat deploy --sc profile --network nurachain --parameters ./ignition/params.json
#    {"profile": {"owner": "0xMultisig", "verifierAdmin": "0xMultisig", "verifierSigner": "0xBackendKey"}}

# 3. register the verifier extension (owner action) and print the resulting state
npm run setup:nurachain:profile

# later: upgrade
PROFILE_UPGRADE_DRY_RUN=1 npm run upgrade:nurachain:profile      # deploy + check only
PROFILE_NEW_IMPLEMENTATION=NuraProfileV2 npm run upgrade:nurachain:profile
```

Environment: `NURACHAIN_RPC_URL`, `NURACHAIN_CHAIN_ID`, `DEPLOYER_PRIVATE_KEY` (see
`.env.example`; prefer `npx hardhat keystore set`). The module is network-agnostic: any `http`
network in `hardhat.config.ts` works, and nothing assumes a chain id. Nurachain's fee floor and
0-fee oracle quirk are handled by the repo's `deploy` task (see the root README).

**Live deployment (Nurachain, chain id 1020, 2026-09-05).** Recorded from Ignition's
`deployed_addresses.json` and checked against the chain: the proxy's ERC-1967 slot points at the
implementation, `lens.core()` and `verifier.profileRegistry()` both return the proxy, and the
runtime code sizes match this build.

| Contract | Address | Role |
| --- | --- | --- |
| `NuraProfileProxy` | `0x8CFbcEf737BE3C67A52A20Ae3DCC685ACF759460` | **the registry** — use with the `NuraProfile` ABI |
| `NuraProfile` (implementation, 1.0.0) | `0x8ff69542387343fe8a9e053779f23058fBbA7f71` | behind the proxy; changes on upgrade |
| `NuraProfileLens` | `0xE8BD8Fc19907274b3CF87Bd72F4cd92Ca3c62F05` | read model |
| `SocialVerifier` | `0xc81bF5e81a9aB9447eeE873b916538750f3161D8` | reference extension; register with `npm run setup:nurachain:profile` |

**Verification.** Nurachain's explorer does not yet accept verification API calls, so verify by
hand: `npx hardhat flatten contracts/profile/NuraProfile.sol > NuraProfile.flat.sol` (and the
proxy, the lens, the verifier), compiler 0.8.28, optimizer on / 200 runs, **viaIR on**, EVM
cancun. Blockscout detects the EIP-1967 proxy automatically once both the proxy and the
implementation are verified.

**What to record.** The proxy address is the registry. Put it (and the lens) into
`web/application/src/config/contracts.ts`; the implementation address changes on every upgrade
and matters only to the verifier.

---

## 16. Tests

```bash
npm run test:profile        # 70 Mocha tests: every function, every wrong caller, events, upgrade, indexer replay
npm run test:solidity       # includes ProfileFuzz.t.sol (12 properties × 256 runs) and ProfileInvariant.t.sol
npx hardhat test mocha test/scripts/modules.test.ts --grep profile   # the Ignition module, deployed and driven
npm run gas:profile         # the table in §12
```

The fuzz suite asserts, for inputs nobody chose: any two spellings of a username that fold to the
same bytes collide; any byte outside the alphabet is rejected wherever it is placed; any value up
to the cap round-trips byte for byte and anything over it fails with its exact length; any casing
of a language tag reads what any other casing wrote; fallback happens exactly when the language is
unset; a kind's list stays consistent under add/remove and ids are never reused. The invariant
suite drives one profile through random typed/generic adds and removes, attribute writes, renames
and transfers, and after every call checks each kind's on-chain list equals the live set, every id
reports its kind (or none, once retired), ids are sequential, and the owner/username indexes agree.
