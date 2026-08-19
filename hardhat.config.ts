import "dotenv/config";

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import { formatEther, parseEther } from "ethers";
import { configVariable, defineConfig, task } from "hardhat/config";
import { ArgumentType } from "hardhat/types/arguments";
import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";

// Each entry is a folder under contracts/ paired with the Ignition module that
// deploys it. Adding a contracts/<name> folder means adding ignition/modules/<name>.ts
// and one line here.
const DEPLOYABLE = ["token", "airdrop", "univ2"] as const;

// contracts/univ2 is vendored UniswapV2, pinned to the compilers it was audited and
// deployed with, so the build needs four of them. Hardhat picks one per file from the
// pragma; none of this is a free choice:
//
//   0.5.16  univ2/core/**           pinned by the vendored source
//   0.6.6   univ2/periphery/**      pinned by the vendored source
//   0.8.12  univ2/vendor/Multicall3 pinned by the vendored source
//   0.8.28  everything of ours, plus univ2/tokens/** (^0.8.20)
//
// The 999999 runs and evmVersion istanbul on the first two are load-bearing: they are
// inputs to the UniswapV2Pair init code hash that UniswapV2Library hardcodes. Changing
// them â€” or moving the Pair source file, which changes the metadata solc appends â€”
// changes that hash and every pair address the router computes. `npm run initcodehash`
// regenerates the constant, and `npm run build` runs it for you.
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

/** Native coin ticker per network. Only used to label the airdrop prompts. */
const COIN: Record<string, string> = {
  nurachain: "NURA",
};

/** 10000000.0 is hard to read when it is the bill you are about to pay; 10,000,000 is not. */
function coinAmount(wei: bigint): string {
  const [whole, fraction] = formatEther(wei).split(".");
  const grouped = BigInt(whole).toLocaleString("en-US");

  return fraction === "0" ? grouped : `${grouped}.${fraction}`;
}

/** A whole number of claims, as a person would type it: 50000, 50_000, 50,000. */
function parseClaims(answer: string): bigint {
  const digits = answer.replace(/[_,\s]/g, "");

  if (!/^\d+$/.test(digits)) {
    throw new Error(`"${answer.trim()}" is not a whole number of claims.`);
  }
  if (BigInt(digits) === 0n) {
    throw new Error("The cap has to be at least 1 â€” the constructor rejects 0.");
  }

  return BigInt(digits);
}

/** A coin amount as a person would type it â€” 200, 0.5 â€” converted to wei. */
function parseReward(answer: string): bigint {
  let wei: bigint;

  try {
    wei = parseEther(answer.replace(/[_,\s]/g, ""));
  } catch {
    throw new Error(`"${answer.trim()}" is not an amount.`);
  }

  // parseEther happily returns a negative, which the uint256 constructor arg cannot hold.
  if (wei <= 0n) {
    throw new Error("The reward has to be above 0 â€” the constructor rejects 0.");
  }

  return wei;
}

/** Reads one already-scaled value out of the --parameters file, in Ignition's own
 *  bigint spelling: a number, or a digit string optionally suffixed with "n". */
function parseFromFile(value: unknown, name: string): bigint | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return BigInt(value);
  }
  if (typeof value === "string" && /^[1-9]\d*n?$/.test(value)) {
    return BigInt(value.replace(/n$/, ""));
  }

  throw new Error(
    `"${name}" in the parameters file is not a positive whole number: ${JSON.stringify(value)}`,
  );
}

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
          "Nothing to ask on â€” stdin is not a terminal. Pass --max-claims and --reward, " +
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
 * --max-claims / --reward, or from the --parameters file, or â€” failing both â€” from a
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
        "once deployed, so neither has a default â€” answer, or re-run with --max-claims\n" +
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
      `          deployed address afterwards â€” this module does not fund it.\n`,
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
// it unset is fine â€” Hardhat then accepts whatever the RPC reports, it just loses the
// safety check that stops you deploying to the wrong chain, and the explorer entry
// below, which has to be keyed by a known chain id.
const nurachainChainId = process.env.NURACHAIN_CHAIN_ID
  ? Number(process.env.NURACHAIN_CHAIN_ID)
  : undefined;

// Nurachain is not a chain hardhat-verify knows, so its explorer has to be described
// here. It is filed under the `blockscout` slot for one reason: that is the provider
// hardhat-verify drives without an API key, and explorer.nurachain.net has no key to
// give. Its /api does answer in the Etherscan shape, but only the `account` module â€”
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
  // the Pair at 200 runs there while `hardhat test` uses 999999 â€” and two different
  // Pairs are two different init code hashes. `isolated` is pinned for the same reason:
  // production isolates by default, the default profile batches, and the batch is
  // visible in the metadata solc appends. Ignition deploys with the production profile,
  // so either difference is one that lands on-chain.
  solidity: {
    profiles: {
      default: { isolated: true, compilers: COMPILERS },
      production: { isolated: true, compilers: COMPILERS },
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

  // Empty when NURACHAIN_CHAIN_ID is unset â€” there is no id to key the entry by, and
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
