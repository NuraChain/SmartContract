import "dotenv/config";

import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";

import { configVariable, defineConfig, task } from "hardhat/config";
import { ArgumentType } from "hardhat/types/arguments";
import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";

import { coinAmount, parseClaims, parseFromFile, parseReward } from "./scripts/lib/params.ts";

// Each entry is a folder under contracts/ paired with the Ignition module that
// deploys it. Adding a contracts/<name> folder means adding ignition/modules/<name>.ts
// and one line here.
const DEPLOYABLE = ["token", "airdrop", "univ2", "univ3", "vault"] as const;

// contracts/univ2 and contracts/univ3 are vendored Uniswap, pinned to the compilers they were
// audited and deployed with, so the build needs five of them. Hardhat picks one per file
// from the pragma; none of this is a free choice:
//
//   0.5.16  univ2/core/**           pinned by the vendored source
//   0.6.6   univ2/periphery/**      pinned by the vendored source
//   0.7.6   univ3/**                pinned by the vendored source (=0.7.6 exactly)
//   0.8.12  univ2/vendor/Multicall3 pinned by the vendored source
//   0.8.28  everything of ours, plus univ2/tokens/** (^0.8.20)
//
// The 999999 runs and evmVersion istanbul on the first two are load-bearing: they are
// inputs to the UniswapV2Pair init code hash that UniswapV2Library hardcodes. Changing
// them — or moving the Pair source file, which changes the metadata solc appends —
// changes that hash and every pair address the router computes. `npm run initcodehash`
// regenerates the constant, and `npm run build` runs it for you.
//
// 0.7.6 is UniswapV3's, and its settings are copied from upstream's own hardhat configs
// rather than chosen. Two reasons, and the second is the hard one:
//
//   1. They are inputs to the pool init code hash, exactly as above — see V3_OVERRIDES.
//   2. Nurachain enforces EIP-170 at exactly 24576 bytes (`eth_call` on a 24577-byte
//      deploy returns "max code size exceeded"), and upstream's own builds land at
//      24535 (UniswapV3Factory) and 24537 (NFTDescriptor). That is 41 and 39 bytes of
//      headroom. `metadata.bytecodeHash: "none"` is worth ~40 of them on its own, so it
//      is not a style preference — drop it and the factory no longer fits on the chain.
//      test/univ3/Build.test.ts asserts every V3 contract against that limit.
//
// A pleasant side effect of bytecodeHash "none": solc then appends no source-path hash,
// so V3 bytecode does not depend on where the files live or on how Hardhat batches them.
const V3_SETTINGS = {
  evmVersion: "istanbul",
  metadata: { bytecodeHash: "none" },
};

const COMPILERS = [
  {
    version: "0.5.16",
    settings: { optimizer: { enabled: true, runs: 999999 }, evmVersion: "istanbul" },
  },
  {
    version: "0.6.6",
    settings: { optimizer: { enabled: true, runs: 999999 }, evmVersion: "istanbul" },
  },
  {
    // v3-core's setting. Also the fallback for every V3 file V3_OVERRIDES does not name.
    version: "0.7.6",
    settings: { optimizer: { enabled: true, runs: 800 }, ...V3_SETTINGS },
  },
  {
    version: "0.8.12",
    settings: { optimizer: { enabled: true, runs: 999999 } },
  },
  {
    version: "0.8.28",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      // OpenZeppelin 5.6 uses `mcopy` in utils/Bytes.sol, which is Cancun-only, so
      // this cannot be lowered to "paris" without downgrading the library. Whether
      // Nurachain implements the Cancun opcodes is not something to take on trust:
      // `npm run preflight:nurachain` estimates each constructor against the node,
      // which executes it, so a chain missing them fails there rather than on-chain.
      evmVersion: "cancun",
    },
  },
];

// v3-core and v3-periphery ship different optimizer settings, and v3-periphery overrides
// three of its own files again, so one number cannot cover contracts/univ3. Copied verbatim
// from upstream's hardhat.config.ts files:
//
//   800        v3-core: UniswapV3Factory, UniswapV3Pool, all core libraries. This one
//              lives in COMPILERS above, as the 0.7.6 default.
//   1000000    v3-periphery's DEFAULT_COMPILER_SETTINGS
//   2000       v3-periphery's LOW: NonfungiblePositionManager, which does not fit at
//              1000000 (it lands 192 bytes under EIP-170 even at 2000)
//   1000       v3-periphery's LOWEST: NonfungibleTokenPositionDescriptor and the
//              NFTDescriptor library it links against — the string and SVG code is what
//              pushes NFTDescriptor to 24537 bytes, 39 under the limit
//
// Every file under contracts/univ3 gets an entry, and the version pin is the reason why.
// Only 19 of the 96 vendored files say `pragma solidity =0.7.6`; the rest are open
// ranges (`>=0.5.0`, `>=0.6.0 <0.8.0`, ...) that 0.8.28 and 0.8.12 also satisfy, and
// Hardhat resolves an open range to the newest compiler that fits. Left alone, the V3
// libraries compile under 0.8.28 and fail on things that are legal in 0.7.6 and not in
// 0.8 — `int24(type(uint8).max)`, `address(uint256(...))`, `chainid()` inside a `pure`
// function. Pinning the whole folder is what keeps V3 on the compiler it was written for.
//
// Runs then follow upstream per file. Which runs value a *dependency* gets does not
// matter — Hardhat compiles a root file together with its imports in one job, under the
// root's settings — so vendor/** inherits from whatever periphery file pulls it in.
const V3_RUNS: Record<string, number> = {
  "contracts/univ3/periphery/NonfungiblePositionManager.sol": 2_000,
  "contracts/univ3/periphery/NonfungibleTokenPositionDescriptor.sol": 1_000,
  "contracts/univ3/periphery/libraries/NFTDescriptor.sol": 1_000,
};

function solidityFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sol"))
    .map((entry) => `${entry.parentPath}/${entry.name}`.split(sep).join("/"));
}

const V3_OVERRIDES = Object.fromEntries(
  solidityFiles("contracts/univ3").map((file) => [
    file,
    {
      version: "0.7.6",
      settings: {
        optimizer: {
          enabled: true,
          // v3-periphery's DEFAULT is 1000000 and v3-core's is 800; anything vendored
          // under univ3/vendor is only ever a dependency, so it rides on 800 harmlessly.
          runs: V3_RUNS[file] ?? (file.startsWith("contracts/univ3/periphery/") ? 1_000_000 : 800),
        },
        ...V3_SETTINGS,
      },
    },
  ]),
);

// contracts/Forecast is vendored from the standalone AuctionHouse prediction-market
// project and pins solc 0.8.24 with its own settings, copied verbatim from that
// project's hardhat.config.ts:
//
//   - 0.8.24 exact pragma on every file; no other compiler satisfies it.
//   - viaIR clears the stack-too-deep the FPMM loops and the struct-heavy
//     createMarket would otherwise hit; runs favour markets that trade far more
//     often than they deploy.
//   - evmVersion cancun because OpenZeppelin 5.6 uses `mcopy` unconditionally
//     (same constraint as our 0.8.28 profile above).
const FORECAST_OVERRIDES = Object.fromEntries(
  solidityFiles("contracts/Forecast").map((file) => [
    file,
    {
      version: "0.8.24",
      settings: {
        viaIR: true,
        optimizer: { enabled: true, runs: 400 },
        evmVersion: "cancun",
      },
    },
  ]),
);

/** Native coin ticker per network. Only used to label the airdrop prompts. */
const COIN: Record<string, string> = {
  nurachain: "NURA",
};

async function readParametersFile(file: string): Promise<Record<string, Record<string, unknown>>> {
  const path = resolve(process.cwd(), file);
  let raw: string;

  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new Error(`Cannot read the --parameters file: ${path}`);
  }

  try {
    return JSON.parse(raw);
  } catch {
    // Ignition itself accepts JSON5, but the airdrop values get merged into this
    // object before they are handed on, so it has to survive a round trip here.
    throw new Error(`The --parameters file is not valid JSON: ${path}`);
  }
}

/**
 * Asks on the terminal, retrying until the answer parses. stdin is opened on first
 * use and has to be closed, so a run that supplies every value up front never touches
 * the terminal at all.
 */
function terminalReader() {
  let rl: ReturnType<typeof createInterface> | undefined;

  return {
    async ask(question: string, parse: (answer: string) => bigint): Promise<bigint> {
      if (process.stdin.isTTY !== true) {
        throw new Error(
          "Nothing to ask on — stdin is not a terminal. Pass --max-claims and --reward, " +
            'or set maxClaims and rewardAmount under "airdrop" in the --parameters file.',
        );
      }

      rl ??= createInterface({ input: process.stdin, output: process.stdout });

      for (;;) {
        try {
          return parse(await rl.question(question));
        } catch (error) {
          console.log(`  ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    },

    close() {
      rl?.close();
    },
  };
}

/**
 * Settles the two airdrop values that must not be guessed on your behalf: the claim
 * cap, which is immutable once deployed, and the per-claim reward. They come from
 * --max-claims / --reward, or from the --parameters file, or — failing both — from a
 * question at the terminal. There is deliberately no default: a cap typed by accident
 * is a cap you live with, and the pool it commits you to funding is real money.
 */
async function resolveAirdropParameters(
  fileParameters: Record<string, unknown>,
  networkName: string,
  options: { maxClaims?: string; reward?: string },
): Promise<{ maxClaims: bigint; rewardAmount: bigint }> {
  const coin = COIN[networkName] ?? "native coin";

  let maxClaims =
    options.maxClaims === undefined
      ? parseFromFile(fileParameters.maxClaims, "airdrop.maxClaims")
      : parseClaims(options.maxClaims);

  let rewardAmount =
    options.reward === undefined
      ? parseFromFile(fileParameters.rewardAmount, "airdrop.rewardAmount")
      : parseReward(options.reward);

  if (maxClaims === undefined || rewardAmount === undefined) {
    console.log(
      "contracts/airdrop needs a claim cap and a per-claim reward. The cap is immutable\n" +
        "once deployed, so neither has a default — answer, or re-run with --max-claims\n" +
        "and --reward.\n",
    );
  }

  const terminal = terminalReader();
  try {
    maxClaims ??= await terminal.ask("  Maximum number of claims: ", parseClaims);
    rewardAmount ??= await terminal.ask(`  Reward per claim, in ${coin}: `, parseReward);
  } finally {
    terminal.close();
  }

  console.log(
    `\n  Cap:    ${maxClaims.toLocaleString("en-US")} claims (immutable)\n` +
      `  Reward: ${coinAmount(rewardAmount)} ${coin} per claim\n` +
      `  Pool:   ${coinAmount(maxClaims * rewardAmount)} ${coin} to cover every claim, sent to the\n` +
      `          deployed address afterwards — this module does not fund it.\n`,
  );

  return { maxClaims, rewardAmount };
}

const deployTask = task("deploy", "Deploy one contracts/<folder> group to the selected network")
  .addOption({
    name: "sc",
    description: `Which contracts folder to deploy: ${DEPLOYABLE.join(" | ")}`,
    type: ArgumentType.STRING_WITHOUT_DEFAULT,
    defaultValue: undefined,
  })
  .addOption({
    name: "parameters",
    description: "Path to a JSON file of module parameters, e.g. ./ignition/params.json",
    type: ArgumentType.FILE_WITHOUT_DEFAULT,
    defaultValue: undefined,
  })
  .addFlag({
    name: "reset",
    description: "Wipe the existing deployment state for this module before deploying",
  })
  .addFlag({
    name: "verify",
    description: "Verify the deployed contracts on the configured block explorer",
  })
  .addOption({
    name: "maxClaims",
    description: "airdrop only: hard cap on claims, e.g. 50000. Asked for if omitted",
    type: ArgumentType.STRING_WITHOUT_DEFAULT,
    defaultValue: undefined,
  })
  .addOption({
    name: "reward",
    description: "airdrop only: coin paid per claim, in whole coin, e.g. 200. Asked for if omitted",
    type: ArgumentType.STRING_WITHOUT_DEFAULT,
    defaultValue: undefined,
  })
  .setInlineAction(async ({ sc, parameters, reset, verify, maxClaims, reward }, hre) => {
    const choices = DEPLOYABLE.join(", ");

    if (sc === undefined) {
      throw new Error(`Missing --sc. Pick one of: ${choices}`);
    }
    if (!DEPLOYABLE.includes(sc as (typeof DEPLOYABLE)[number])) {
      throw new Error(`Unknown --sc "${sc}". Pick one of: ${choices}`);
    }
    if (sc !== "airdrop" && (maxClaims !== undefined || reward !== undefined)) {
      throw new Error(`--max-claims and --reward only apply to --sc airdrop, not --sc ${sc}.`);
    }

    console.log(`Deploying contracts/${sc} via ignition/modules/${sc}.ts\n`);

    // Ignition's --parameters takes either a path or a literal JSON5 string. The airdrop
    // values are settled here rather than in the module, so they go on as a string with
    // whatever the file already held merged underneath. Every other group hands the path
    // straight through, which is what keeps JSON5 files working for them.
    let resolvedParameters = parameters;

    if (sc === "airdrop") {
      const fileParameters = parameters === undefined ? {} : await readParametersFile(parameters);
      const airdrop = await resolveAirdropParameters(
        fileParameters.airdrop ?? {},
        hre.globalOptions.network,
        { maxClaims, reward },
      );

      resolvedParameters = JSON.stringify({
        ...fileParameters,
        airdrop: {
          ...fileParameters.airdrop,
          maxClaims: `${airdrop.maxClaims}n`,
          rewardAmount: `${airdrop.rewardAmount}n`,
        },
      });
    }

    await hre.tasks.getTask(["ignition", "deploy"]).run({
      modulePath: `ignition/modules/${sc}.ts`,
      parameters: resolvedParameters,
      reset,
      verify,
    });
  })
  .build();

// Hardhat needs chainId as a literal number when the config loads, so it cannot come
// from configVariable() the way the lazy secrets below do. Nurachain is not in any
// public chain registry, so put its id in .env rather than guessing it here. Leaving
// it unset is fine — Hardhat then accepts whatever the RPC reports, it just loses the
// safety check that stops you deploying to the wrong chain, and the explorer entry
// below, which has to be keyed by a known chain id.
const nurachainChainId = process.env.NURACHAIN_CHAIN_ID
  ? Number(process.env.NURACHAIN_CHAIN_ID)
  : undefined;

// Nurachain is not a chain hardhat-verify knows, so its explorer has to be described
// here. It is filed under the `blockscout` slot for one reason: that is the provider
// hardhat-verify drives without an API key, and explorer.nurachain.net has no key to
// give. Its /api does answer in the Etherscan shape, but only the `account` module —
// `contract/verifysourcecode` returns "unsupported module", so `--verify` cannot work
// against it yet. This entry is here so the explorer is already pointed at correctly
// when Nurachain ships verification; until then, verify by hand with
// `npx hardhat flatten <file>`. See the verification note in README.md.
const NURACHAIN_EXPLORER = {
  name: "Nura Explorer",
  url: "https://explorer.nurachain.net",
  apiUrl: "https://explorer.nurachain.net/api",
};

export default defineConfig({
  plugins: [hardhatToolboxMochaEthers],
  tasks: [deployTask],

  // Spelled out per profile, not as a bare `compilers` list, and isolated on both.
  // Hardhat builds its "production" profile by copying only the compiler *versions*
  // out of your config and dropping your settings for its own, so a bare list rebuilds
  // the Pair at 200 runs there while `hardhat test` uses 999999 — and two different
  // Pairs are two different init code hashes. `isolated` is pinned for the same reason:
  // production isolates by default, the default profile batches, and the batch is
  // visible in the metadata solc appends. Ignition deploys with the production profile,
  // so either difference is one that lands on-chain.
  solidity: {
    profiles: {
      default: { isolated: true, compilers: COMPILERS, overrides: { ...V3_OVERRIDES, ...FORECAST_OVERRIDES } },
      production: { isolated: true, compilers: COMPILERS, overrides: { ...V3_OVERRIDES, ...FORECAST_OVERRIDES } },
    },
  },

  networks: {
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
    },

    nurachain: {
      type: "http",
      chainType: "l1",
      chainId: nurachainChainId,
      url: configVariable("NURACHAIN_RPC_URL"),
      accounts: [configVariable("DEPLOYER_PRIVATE_KEY")],
    },
  },

  // Empty when NURACHAIN_CHAIN_ID is unset — there is no id to key the entry by, and
  // hardhat-verify would have nothing to match the connected network against anyway.
  chainDescriptors:
    nurachainChainId === undefined
      ? {}
      : {
          [nurachainChainId]: {
            name: "Nurachain",
            blockExplorers: { blockscout: NURACHAIN_EXPLORER },
          },
        },

  verify: {
    // Etherscan is off outright: it does not index Nurachain, and leaving it enabled
    // only produces a missing-API-key error on the way to a provider that could never
    // have verified anything here.
    etherscan: { enabled: false },
    blockscout: { enabled: true },
  },
});
