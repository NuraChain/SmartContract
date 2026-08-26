# Testing

One suite, one runner. Everything is [vitest](https://vitest.dev); there is no
second framework to learn and nothing to start before running it - no database
to provision, no chain to boot, no network at all. Chain-touching code is kept
behind pure modules so the important logic classifies, parses, and formats
without a connection.

```sh
npm test              # the application suite
npm run verify        # the full gate CI runs: rtl lint, types, lint, build, tests
```

## What lives where

| Spec | Covers |
| --- | --- |
| `tests/abi.spec.ts` | ABI parsing: read/write split, signatures, payable flags, tuple/array specs, `parseValue` for every supported type (raw vs human units, JSON arrays/tuples, hex widths), `weiHint`, `formatValue` |
| `tests/contracts-config.spec.ts` | registry integrity: unique ids, chain id 1020 only, checksummed-or-null addresses, non-empty ABIs with callables, `staticCallables` consistency |
| `tests/errors.spec.ts` | the failure taxonomy: plain-object EIP-1193 rejections, -32002 pending requests, chain mismatch, insufficient funds, `Error(string)` + `Panic(uint256)` decode, RPC failures, technical-detail preservation |
| `tests/format.spec.ts` | address shortening, digit grouping, native amounts, gas formatting, relative time |
| `tests/history.spec.ts` | activity log: record/update/drop, newest-first order, bigint round-trips through localStorage |
| `tests/app.spec.ts` | rendered journeys through `App({ url })`: dashboard shell, not-found fallback, contracts list with honest no-address cards, activity empty state |
| `tests/ssr-safety.spec.ts` | imports the ENTIRE page graph under plain Node - any module-scope `window`/`localStorage` touch fails here before the build does |

Add `-- <pattern>` to narrow, and `-- -t "<name>"` to run one test:

```sh
npm test -- tests/abi.spec.ts
npm test -- -t "scales decimal input"
```

## Coverage

```sh
npm run coverage      # HTML in application/coverage
```

Measured over `src/**/*.{ts,azeroth}` through the same transform the app ships;
`entry.server.ts` and `vite-env.d.ts` are excluded.

## Conventions

- Pages that call `useParams` must be exercised through `App({ url })` -
  mounting them bare throws "found no router".
- `renderTest` from `@azerothjs/testing`; register `cleanup` in `afterEach`.
- No network mocks: if a test needs a chain answer, the logic under test is in
  the wrong layer.
