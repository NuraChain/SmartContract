import "dotenv/config";

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";

import { configVariable, defineConfig, task } from "hardhat/config";
import { ArgumentType } from "hardhat/types/arguments";
import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";

import { coinAmount, parseClaims, parseFromFile, parseReward } from "./scripts/lib/params.ts";

// ── Nurachain Ignition patch ────────────────────────────────────────────
// Nurachain (1020) returns baseFeePerGas=0 but enforces 47 gwei floor.
// Upstream @nomicfoundation/ignition-core treats any 0-baseFee chain as
// zero-fee (intended for private Besu) and returns maxFee 0, ignoring
// networks.nurachain.ignition.{maxFeePerGas,gasPrice}. The check explicitly
// excludes BSC/opBNB (56,97,204,5611) – 1020 must be excluded too.
// We patch both src and dist at startup so `npm install` does not regress.
// See node_modules/@nomicfoundation/ignition-core/src/internal/execution/jsonrpc-client.ts:680
// ───────────────────────────────────────────────────────────────────────
try {
  const src = resolve(process.cwd(), "node_modules/@nomicfoundation/ignition-core/src/internal/execution/jsonrpc-client.ts");
  const dist = resolve(process.cwd(), "node_modules/@nomicfoundation/ignition-core/dist/src/internal/execution/jsonrpc-client.js");
  for (const file of [src, dist]) {
    if (!existsSync(file)) continue;
    let content = readFileSync(file, "utf8");
    if (content.includes("chainId !== 1020")) continue; // already patched
    if (content.includes("chainId !== 5611")) {
      content = content.replace(
        /chainId !== 5611(\s*\)?)/,
        "chainId !== 5611 &&\n        chainId !== 1020$1",
      );
      content = content.replace("&&\n        chainId !== 1020)", "&&\n                chainId !== 1020)");
      writeFileSync(file, content, "utf8");
      console.log(`[hardhat.config] patched Nurachain fees in ${file}`);
    }
  }
} catch {
  // best-effort: if patch fails, deploy will still show 0-fee in diagnostics
}

// Each entry is a folder under contracts/ paired with the Ignition module that
// deploys it. Adding a contracts/<name> folder means adding ignition/modules/<name>.ts
// and one line here.
const DEPLOYABLE = ["token", "airdrop", "univ3", "vault", "forecast", "profile"] as const;

// contracts/univ3 is vendored Uniswap, pinned to the compiler it was audited and deployed
// with, so the build needs three compilers. Hardhat picks one per file from the pragma;
// none of this is a free choice:
//
//   0.6.6   testing/WNURA.sol       pinned by the vendored Dapphub WETH9 source
//   0.7.6   univ3/**                pinned by the vendored source (=0.7.6 exactly)
//   0.8.28  everything of ours, plus testing/MockToken.sol (^0.8.20)
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
    version: "0.6.6",
    settings: { optimizer: { enabled: true, runs: 999999 }, evmVersion: "istanbul" },
  },
  {
    // v3-core's setting. Also the fallback for every V3 file V3_OVERRIDES does not name.
    version: "0.7.6",
    settings: { optimizer: { enabled: true, runs: 800 }, ...V3_SETTINGS },
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

// contracts/forecast is vendored from the standalone AuctionHouse prediction-market
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
  solidityFiles("contracts/forecast").map((file) => [
    file,
    {
      version: "0.8.24",
      settings: {
        // PredictionPool uses simple functions and doesn't need viaIR; disabling it
        // avoids compiler-generated tuple decoder functions that appear as unnamed
        // selectors in the dispatcher (e.g. 0xd628548b).
        viaIR: !file.endsWith("PredictionPool.sol"),
        optimizer: { enabled: true, runs: 400 },
        evmVersion: "cancun",
      },
    },
  ]),
);

// contracts/profile is the UUPS profile registry. It compiles with the repo's 0.8.28 profile
// (cancun, runs 200) plus viaIR, for one reason: Nurachain enforces EIP-170 at exactly
// 24576 bytes, and the legacy pipeline lands NuraProfile at ~25.4 KB. The Yul pipeline
// brings it well under the limit with room for future implementation versions, and
// removes the stack-too-deep ceiling the lens projections otherwise hit. Applied to the
// whole folder so the lens, the proxy, the extensions and the mocks share one build.
const PROFILE_OVERRIDES = Object.fromEntries(
  solidityFiles("contracts/profile").map((file) => [
    file,
    {
      version: "0.8.28",
      settings: {
        viaIR: true,
        optimizer: { enabled: true, runs: 200 },
        evmVersion: "cancun",
      },
    },
  ]),
);

/** Native coin ticker per network. Only used to label the airdrop prompts. */
const COIN: Record<string, string> = {
  nurachain: "NURA",
};

// ── deploy logger ──────────────────────────────────────────────────────────
// Writes to console and to logs/deploy-<network>-<sc>-<timestamp>.log so a
// dropped-tx (HHE10400) can be diagnosed without re-running. Never logs the
// private key – only address / balance / fee fields.
// ──────────────────────────────────────────────────────────────────────────
function deployLogFile(network: string, sc: string): string {
  const dir = resolve(process.cwd(), "logs");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return resolve(dir, `deploy-${network}-${sc}-${ts}.log`);
}

function deployLog(line: string, file?: string): void {
  console.log(line);
  if (file) {
    try {
      appendFileSync(file, line + "\n");
    } catch {}
  }
}

function fmtWei(value: unknown): string {
  try {
    const n = typeof value === "bigint" ? value : BigInt(String(value));
    const gwei = Number(n) / 1e9;
    return `${n.toString()} wei (${gwei.toFixed(2)} gwei)`;
  } catch {
    return String(value);
  }
}

function maskRpc(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return url.slice(0, 48) + (url.length > 48 ? "…" : "");
  }
}

async function logDeployDiagnostics(
  hre: {
    network: { create: () => Promise<{ provider: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> }; ethers?: unknown }> };
    config: { networks: Record<string, unknown> };
  },
  networkName: string,
  sc: string,
  logFile: string,
): Promise<{ provider: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> } | undefined }> {
  const header = `\n========== DEPLOY DIAGNOSTICS  network=${networkName}  sc=${sc}  time=${new Date().toISOString()} ==========`;
  deployLog(header, logFile);

  // Config as Hardhat sees it (after merging profiles)
  try {
    const netCfg = (hre.config.networks as Record<string, Record<string, unknown>>)[networkName] as
      | Record<string, unknown>
      | undefined;
    deployLog(`[config] networks.${networkName} = ${JSON.stringify(netCfg, (_, v) => (typeof v === "bigint" ? `${v}n` : v), 2)}`, logFile);
  } catch (e) {
    deployLog(`[config] failed to read hre.config.networks: ${String(e)}`, logFile);
  }

  // Hardhat 3: provider lives on the connection returned by hre.network.create()
  // (see scripts/preflight.ts:69 `await network.getOrCreate()`). The old
  // `hre.network.provider` does not exist – that is why previous runs logged
  // `Cannot read properties of undefined (reading 'request')` for every rpc call.
  let provider: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> } | undefined;
  let ethers: unknown;
  try {
    const conn = await hre.network.create();
    provider = (conn as { provider: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> } }).provider;
    ethers = (conn as { ethers?: unknown }).ethers;
    deployLog(`[diag] network connection established`, logFile);
  } catch (e) {
    deployLog(`[diag] hre.network.create() FAILED: ${e instanceof Error ? e.message : String(e)}`, logFile);
  }

  if (!provider) {
    deployLog(`[diag] no provider – skipping rpc checks (run npm run preflight:nurachain for direct provider diagnostics)`, logFile);
    // still continue to journal peek below
  } else {
    const rpcCall = async (method: string, params: unknown[] = []): Promise<unknown> => {
      try {
        const res = await provider!.request({ method, params });
        const pretty = typeof res === "string" ? res : JSON.stringify(res);
        deployLog(`[rpc] ${method}(${JSON.stringify(params)}) => ${pretty}`, logFile);
        return res;
      } catch (e) {
        deployLog(`[rpc] ${method} FAILED: ${e instanceof Error ? e.message : String(e)}`, logFile);
        return undefined;
      }
    };

    // Chain / gas oracle – Nurachain is known to return 0 for gasPrice
    await rpcCall("eth_chainId");
    await rpcCall("net_version");
    const gasPrice = await rpcCall("eth_gasPrice");
    await rpcCall("eth_maxPriorityFeePerGas");
    await rpcCall("eth_feeHistory", ["0x5", "latest", [25, 75]]);
    await rpcCall("eth_blockNumber");

    if (gasPrice !== undefined) {
      deployLog(`[diag] eth_gasPrice raw=${String(gasPrice)}  decoded=${fmtWei(gasPrice)}`, logFile);
      try {
        if (BigInt(String(gasPrice)) === 0n) {
          deployLog(`[diag] ⚠ eth_gasPrice is 0 – Ignition would send 0-fee tx if networks.${networkName}.ignition.gasPrice is not set. Expected 500_000_000_000n (500 gwei) per hardhat.config.ts:400`, logFile);
        }
      } catch {}
    }

    // Deployer account
    try {
      const accounts = (await provider.request({ method: "eth_accounts", params: [] })) as string[] | undefined;
      deployLog(`[diag] eth_accounts => ${JSON.stringify(accounts)}`, logFile);
      const target = accounts?.[0];
      if (target) {
        const bal = (await provider.request({ method: "eth_getBalance", params: [target, "latest"] })) as string | undefined;
        const nonce = (await provider.request({ method: "eth_getTransactionCount", params: [target, "latest"] })) as string | undefined;
        const pendingNonce = (await provider.request({ method: "eth_getTransactionCount", params: [target, "pending"] })) as string | undefined;
        deployLog(`[diag] deployer ${target}  balance=${bal ? fmtWei(bal) : "?"}  nonce latest=${nonce} pending=${pendingNonce}`, logFile);
        if (bal && BigInt(bal) === 0n) deployLog(`[diag] ✖ deployer balance is 0 – funding needed before deploy`, logFile);
        // also log via ethers if available for formatEther
        if (ethers && target && bal) {
          try {
            const eth = ethers as { formatEther?: (v: string | bigint) => string; provider?: { getBalance?: (a: string) => Promise<bigint> } };
            if (eth.formatEther) deployLog(`[diag] deployer balance formatted: ${eth.formatEther(BigInt(bal))} native`, logFile);
          } catch {}
        }
      }
    } catch (e) {
      deployLog(`[diag] deployer lookup failed: ${String(e)}`, logFile);
    }
  }

  // Journal quick peek
  try {
    const journalPath = resolve(process.cwd(), `ignition/deployments/chain-${process.env.NURACHAIN_CHAIN_ID ?? "1020"}/journal.jsonl`);
    if (existsSync(journalPath)) {
      const lines = readFileSync(journalPath, "utf8").trim().split("\n");
      const last = lines.slice(-8).join("\n");
      deployLog(`[diag] journal ${journalPath}  lines=${lines.length}\n[last 8 lines]\n${last}`, logFile);
      // surface 0-fee pattern that causes HHE10400
      const zeroFee = lines.filter((l) => l.includes('"value":"0"') && l.includes("maxFeePerGas")).length;
      if (zeroFee > 0) deployLog(`[diag] ⚠ journal contains ${zeroFee} tx(s) with maxFeePerGas=0 – they will be dropped by Nurachain (floor ~47 gwei). Use --reset after fixing ignition.gasPrice.`, logFile);
    } else {
      deployLog(`[diag] no journal yet at ${journalPath} (first deploy)`, logFile);
    }
  } catch (e) {
    deployLog(`[diag] journal read failed: ${String(e)}`, logFile);
  }

  deployLog(`========== END DIAGNOSTICS ==========\n`, logFile);
  return { provider };
}

function dumpJournalOnFailure(networkName: string, logFile: string): void {
  try {
    const chainId = process.env.NURACHAIN_CHAIN_ID ?? "1020";
    const journalPath = resolve(process.cwd(), `ignition/deployments/chain-${chainId}/journal.jsonl`);
    if (!existsSync(journalPath)) {
      deployLog(`[fail] no journal at ${journalPath}`, logFile);
      return;
    }
    const raw = readFileSync(journalPath, "utf8");
    const lines = raw.trim().split("\n");
    deployLog(`\n[fail] ===== JOURNAL DUMP (${lines.length} lines) ${journalPath} =====`, logFile);
    // last 30 lines are enough to see ONCHAIN_INTERACTION_DROPPED loop
    for (const line of lines.slice(-30)) deployLog(`[journal] ${line}`, logFile);
    // also write full copy to log dir for sharing
    try {
      const copy = resolve(process.cwd(), `logs/journal-chain-${chainId}-${Date.now()}.jsonl`);
      appendFileSync(copy, raw);
      deployLog(`[fail] full journal copied to ${copy}`, logFile);
    } catch {}
    deployLog(`[fail] ===== END JOURNAL =====\n`, logFile);
  } catch (e) {
    deployLog(`[fail] dumpJournal failed: ${String(e)}`, logFile);
  }
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

    const networkName = hre.globalOptions.network as string;
    const logFile = deployLogFile(networkName, sc);
    deployLog(`\n[deploy] Deploying contracts/${sc} via ignition/modules/${sc}.ts  network=${networkName}  reset=${String(reset)}  verify=${String(verify)}`, logFile);
    if (parameters) deployLog(`[deploy] --parameters=${parameters}`, logFile);
    deployLog(`[deploy] logFile=${logFile}`, logFile);
    // Masked RPC for sanity-check (never logs secrets)
    try {
      const rawUrl = (hre.config.networks[networkName] as unknown as { url?: unknown })?.url;
      // configVariable values resolve lazily via hre.network – also try provider-level
      deployLog(`[deploy] config networks.${networkName}.url type=${typeof rawUrl}`, logFile);
    } catch {}

    // Pre-flight diagnostics: gas oracle, deployer balance/nonce, ignition config, journal
    await logDeployDiagnostics(
      hre as unknown as {
        network: { create: () => Promise<{ provider: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> }; ethers?: unknown }> };
        config: { networks: Record<string, unknown> };
      },
      networkName,
      sc,
      logFile,
    );

    // Hardhat Ignition caches strategyConfig in the journal at first run.
    // If the first run used an empty strategyConfig (old config without
    // ignition.gasPrice) it will keep resending 0-fee txs forever, even
    // after hardhat.config.ts is fixed. Detect that stale state and force
    // a reset so the new maxFeePerGas (500 gwei) is actually used.
    let effectiveReset = reset;
    {
      const chainId = process.env.NURACHAIN_CHAIN_ID ?? "1020";
      const jPath = resolve(process.cwd(), `ignition/deployments/chain-${chainId}/journal.jsonl`);
      if (existsSync(jPath)) {
        const raw = readFileSync(jPath, "utf8");
        const hasDropped = raw.includes("ONCHAIN_INTERACTION_DROPPED");
        const hasReplacedByUser = raw.includes("ONCHAIN_INTERACTION_REPLACED_BY_USER");
        const hasZeroFee = raw.includes('"maxFeePerGas":{"_kind":"bigint","value":"0"}');
        const hasEmptyStrategyConfig = raw.includes('"strategyConfig":{}');
        if ((hasDropped || hasReplacedByUser) && hasZeroFee) {
          deployLog(`[deploy] ⚠ stale journal detected: ${hasDropped ? "ONCHAIN_INTERACTION_DROPPED" : ""}${hasReplacedByUser ? " ONCHAIN_INTERACTION_REPLACED_BY_USER" : ""} with maxFeePerGas=0 + strategyConfig={}`, logFile);
          deployLog(`[deploy]   Root cause: first deploy ran before ignition.gasPrice/maxFeePerGas was set (see hardhat.config.ts:619).`, logFile);
          deployLog(`[deploy]   Ignition resumes the same 0-fee interaction – new fees are ignored until journal is wiped.`, logFile);
          if (!reset) {
            deployLog(`[deploy] → auto-wiping stale deployment (equivalent to --reset) so new 500 gwei fees take effect`, logFile);
            try {
              const { rmSync } = await import("node:fs");
              const deploymentDir = resolve(process.cwd(), `ignition/deployments/chain-${chainId}`);
              rmSync(deploymentDir, { recursive: true, force: true });
              deployLog(`[deploy]   wiped ${deploymentDir}`, logFile);
              effectiveReset = true;
            } catch (e) {
              deployLog(`[deploy]   wipe failed: ${String(e)} – please run manually: Remove-Item -Recurse -Force ignition/deployments/chain-${chainId}`, logFile);
              deployLog(`[deploy]   → re-run with --reset:  npm run deploy:nurachain:${sc} -- --reset`, logFile);
            }
          } else {
            deployLog(`[deploy]   --reset already set, Ignition will recreate deployment with correct fees`, logFile);
          }
          if (hasEmptyStrategyConfig) {
            deployLog(`[deploy]   strategyConfig={} in journal confirms empty config was cached at init`, logFile);
          }
        } else if (hasDropped) {
          deployLog(`[deploy] ⚠ journal contains ONCHAIN_INTERACTION_DROPPED – previous run was dropped. If fees were fixed, use --reset.`, logFile);
        }
      }
    }

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

    deployLog(`[deploy] → calling ignition deploy  module=ignition/modules/${sc}.ts  effectiveReset=${String(effectiveReset)}`, logFile);
    const t0 = Date.now();
    try {
      await hre.tasks.getTask(["ignition", "deploy"]).run({
        modulePath: `ignition/modules/${sc}.ts`,
        parameters: resolvedParameters,
        reset: effectiveReset,
        verify,
      });
      deployLog(`[deploy] ✓ ignition finished in ${((Date.now() - t0) / 1000).toFixed(1)}s`, logFile);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      deployLog(`\n[deploy] ✖ ignition failed after ${((Date.now() - t0) / 1000).toFixed(1)}s`, logFile);
      deployLog(`[deploy] error: ${msg}`, logFile);
      if (stack) deployLog(`[deploy] stack:\n${stack}`, logFile);

      // HHE10400-specific hint + journal dump
      if (msg.includes("HHE10400") || msg.includes("were dropped") || msg.includes("ONCHAIN_INTERACTION_DROPPED")) {
        deployLog(`\n[deploy] ── HHE10400 diagnosis ──`, logFile);
        deployLog(`[deploy] All txs in the batch were dropped by the node mempool.`, logFile);
        deployLog(`[deploy] Common causes on Nurachain:`, logFile);
        deployLog(`[deploy]  1) fee < 47 gwei – node reports eth_gasPrice=0 but enforces floor. Check [rpc] eth_gasPrice above and that ignition.gasPrice=500_000_000_000n is in [config].`, logFile);
        deployLog(`[deploy]  2) stale journal with 0-fee tx – run with --reset:  npm run deploy:nurachain:${sc} -- --reset`, logFile);
        deployLog(`[deploy]  3) deployer balance 0 or nonce gap – check [diag] deployer line above.`, logFile);
        deployLog(`[deploy]  4) RPC mismatch (wrong NURACHAIN_RPC_URL / chainId) – compare eth_chainId vs NURACHAIN_CHAIN_ID.`, logFile);
        dumpJournalOnFailure(networkName, logFile);
      } else {
        dumpJournalOnFailure(networkName, logFile);
      }

      deployLog(`[deploy] full log saved to ${logFile}`, logFile);
      throw error;
    }

    deployLog(`[deploy] full log saved to ${logFile}`, logFile);
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
  // out of your config and dropping your settings for its own, so a bare list would
  // rebuild the V3 pool with different settings on deploy than under `hardhat test`
  // — which is exactly how an init code hash drifts. `isolated` is pinned for the
  // same reason: production isolates by default, the default profile batches, and
  // the batch is visible in the metadata solc appends. Ignition deploys with the
  // production profile, so either difference is one that lands on-chain.
  solidity: {
    profiles: {
      default: { isolated: true, compilers: COMPILERS, overrides: { ...V3_OVERRIDES, ...FORECAST_OVERRIDES, ...PROFILE_OVERRIDES } },
      production: { isolated: true, compilers: COMPILERS, overrides: { ...V3_OVERRIDES, ...FORECAST_OVERRIDES, ...PROFILE_OVERRIDES } },
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

      // The node rejects any tx priced below ~47 gwei (every mined tx pays exactly
      // that), yet its RPC reports eth_gasPrice and eth_maxPriorityFeePerGas as 0.
      // Left alone, Ignition prices deploys off those zeros and the node drops the
      // txs from the mempool — HHE10400, "all transactions were dropped". Pin fees
      // above the floor instead of trusting the fee oracle. Both legacy and EIP-1559
      // fields are set because Ignition sends type-2 on this network (see journal
      // maxFeePerGas=0) and would otherwise ignore a lone gasPrice.
      ignition: {
        gasPrice: 500_000_000_000n,
        maxFeePerGas: 500_000_000_000n,
        maxPriorityFeePerGas: 5_000_000_000n,
      },
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
