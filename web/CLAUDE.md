# Contract Manager — working notes for Claude Code

A transparent admin panel for the contracts deployed to Nura Chain (EVM, chain
id 1020). One workspace:

```
application/   compiled .azeroth components on vite (AzerothJS)
```

The contracts live in the **parent repository** (`C:\Users\Alex\Desktop\Smart
Contract`, this repo's root). This app consumes its compiled artifacts
(`src/config/abi/*.json`, refreshed by `node scripts/extract-abi.mjs` after a
`npx hardhat compile` there) and never imports Solidity.

---

# Frontend

## Architecture

**AzerothJS 2** (`.azeroth` single-file components) on **Vite 8**,
**TypeScript 6**, **TailwindCSS 4**, **viem 2**. There is **no React** here —
no hooks, no `useMemo`/`useCallback`/memo. A component reads:

```
export default component Name(props: { ... })
{
    state x = 0;            // reactive local state; read/write WITHOUT ()
    derived y = x * 2;      // computed; read WITHOUT ()
    effect (x) { ... }      // reruns when a listed dep changes
    mount { ... }           // browser-only; cleanup { ... } tears down
    <div>markup is the final expression</div>
}
```

### Framework semantics that bite (learned the hard way)

- `state`/`derived` values are **plain variables** in templates — `x`, never
  `x()`. Imported signals (the wallet store) ARE callable getters.
- Plain `const fn = () => ...` helpers stay callable; call them inside markup
  where tracking is needed.
- `<For each={} key={}>` rows must root at a **host element**. A component tag
  is a fragment to the reconciler — wrap component rows in `<div>`/`<li>`.
- `<For>` has **no index binding**. Map first:
  `each={ items.map((item, index) => ({ item, index })) }`.
- `<Show when={ expr } let={ value }>` binds THE WHEN VALUE. For narrowing,
  pass the value itself (`when={ hash }`), not a comparison.
- Multiple `component Name()` declarations per file are legal (grammar:
  `(OpaqueTS | ComponentDecl)*`) — used for small local subcomponents.
- Markup expression braces need exactly one inner space: `{ expr }`.

Markup control flow is `<Show when={} fallback={} let={}>` and
`<For each={} key={} let={}>`. Routes live once in `src/routes.ts`; `/`
prerenders (`render: 'static'`), everything else is lazy `'client'`.

**SSR safety matters**: the prerender evaluates every page module, so nothing
may touch `window`/`localStorage` at module scope. `tests/ssr-safety.spec.ts`
is the gate. Lazy localStorage reads go through try/catch (see
`lib/history.ts`).

## Design system

`application/src/styles.css` is the single source of truth. Tokens are CSS
variables resolved through `light-dark()` and exposed to Tailwind via
`@theme inline`: `bg` `panel` `raised` · `ink` `faint` · `ice`
(`ice-hi`/`ice-lo`/`ice-ink`) · `val` `rise` `fall` · `line` `line-strong` ·
`glow`.

`val` (gold) is reserved for **on-chain numbers**; `rise`/`fall` mark
confirmed/reverted. Type roles: `font-display` (Unbounded), `font-sans` (IBM
Plex Sans), `font-mono` (IBM Plex Mono). Surface classes: `.card`, `.card-pop`,
`.btn-ice`, `.btn-ghost`, `.eyebrow`, plus the overlay choreography
(`.anim-overlay` / `.anim-pop` / `.is-closing`).

There is **no `tailwind.config.js`** and there must not be one. Button variants
are full literal class strings in `components/ui/variants.ts`.

## Component rules

```
Existing component -> Reuse -> Extend with an optional prop -> Create new, with a reason
```

Inventory:

```
ui/         button empty-state icon input modal shamseh toasts variants.ts
wallet/     add-chain-button connect-button wallet-menu wallet-modal
contract/   copy-button contract-card param-field read-card write-card
            tx-review-modal wrong-network-banner
layout/     footer header
```

No new UI framework, no CSS-in-JS, no hex colours in components.

## Responsive + RTL + a11y

Page shell is `mx-auto max-w-6xl px-4 py-8 sm:py-12`; `sm:` carries the
mobile→desktop switch. Target viewports: **1440×900**, **1024×768**,
**390×844**.

The app ships English-only now, but `npm run lint:rtl` still runs in CI and
rejects physical direction utilities (`ml-*`, `pr-*`, `left-*`,
`text-right`, …). Use logical utilities (`ms/me`, `ps/pe`, `start/end`) and
keep addresses/hashes/amounts as LTR islands with `data-ltr`.

Prefer native HTML semantics over ARIA. Enumerated ARIA state only:
`aria-pressed={ String(on) }`. One `h1` per page; icon-only controls need an
`aria-label`; dialogs carry `role="dialog"`, `aria-modal`, a label, focus on
open, Escape to close (see `ui/modal.component.azeroth`).

## The contract registry

`src/config/contracts.ts` is the ONLY place contracts are defined. ABIs under
`src/config/abi/` are extracted from the contracts repository's Hardhat
artifacts by `scripts/extract-abi.mjs` (bytecode deliberately dropped). An
address of `null` means "no deployment recorded" — the UI says exactly that;
do not invent addresses. `staticCallables` lists revert-to-answer functions
(QuoterV2 pattern) so they render as reads.

Every entry has a `folder`: the `contracts/<folder>` it is built from in the
contracts repository. `FOLDERS` (same file) is the ordered list of sections the
contracts page renders — one per repository folder, with its path, description
and deploy command — so a new `contracts/<name>` folder there means a new
`FOLDERS` entry here, and nothing else. `category` remains the short badge label.

## Wallet + transaction flow

- Discovery/connection: `lib/wallet/store.ts` (EIP-6963, session restore via
  rdns at `cm.wallet`, account/chain events deduped by WeakSet). The signing
  client and the account signal move TOGETHER through `adoptAccount`.
- Writes: `lib/tx-manager.ts` owns prepare (guards → encodeFunctionData →
  estimateContractGas with classified failures) and submit (sign → hash →
  receipt → history + toast + epoch bump). UI phases live in
  `tx-review-modal.component.azeroth`: preparing → review → signing → pending
  → confirmed/failed. Never bypass the review step; confirm buttons always
  name the function.
- Errors: `lib/errors.ts` classifies plain-object EIP-1193 rejections, chain
  mismatches, insufficiency, revert data (`Error(string)`/`Panic(uint256)`),
  and RPC failures into `{ code, title, hint, technical }`. User-facing title,
  expandable technical detail.

## Testing workflow

vitest everywhere; no second runner. Component tests go through `renderTest`
from `@azerothjs/testing` with `cleanup` registered in `afterEach`. Pages that
call `useParams` must be exercised through `App({ url })`, not mounted bare.

```sh
npm test                # application suite
npm run coverage        # HTML in application/coverage
```

See `TESTING.md` for the map.

## Performance rules

Measure before changing. Animations stay on `opacity`/`transform`;
`prefers-reduced-motion: reduce` disables them in `@layer base`. Trading pages
are lazy routes; keep them that way. The wallet store refreshes on receipts and
a 5s visible-tab timer, never per block.

## Gates before calling frontend work done

```sh
npm run lint:rtl        # physical direction utilities
npx azeroth check       # types + lint
npm run build           # client + SSR bundle + prerender
npm test
```

Plus: seen in a browser at all three viewports, with a clean console.
