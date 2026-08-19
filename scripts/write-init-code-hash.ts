import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { keccak256 } from "ethers";

/**
 * Rewrites the pool init code hashes baked into the vendored Uniswap libraries — one for
 * V2, one for V3.
 *
 *   npm run initcodehash        (or: node scripts/write-init-code-hash.ts)
 *
 * Both AMMs compute a pool's address with CREATE2 arithmetic instead of asking the
 * factory, which takes the keccak256 of the pool's creation bytecode as a compile-time
 * constant — `UniswapV2Library.pairFor` and `PoolAddress.computeAddress`. The value
 * Uniswap publishes is the hash of *their* build. Ours can differ: solc appends a
 * metadata hash covering source paths and compiler settings, so a repo with its own
 * layout gets its own hash, and the shipped constant would then send every router call
 * to an address with no contract on it. Every swap and every addLiquidity would revert,
 * and nothing about the failure points here.
 *
 * So: compile, hash our own pool, patch the constant, compile again so the periphery
 * picks it up. `npm run build` does all three. test/UniV2.test.ts and test/univ3/Build.test.ts
 * prove the results match what the factories really deploy.
 *
 * The two behave differently, and deliberately:
 *
 *   V2  is PINNED, because its hash depends on things that are not the AMM. solc appends
 *       a metadata hash covering the source paths and compiler settings, so the optimizer
 *       runs, the evmVersion, a build profile's `isolated` flag — or simply moving the
 *       folder — all move it. A silent rewrite is how a router ends up computing pair
 *       addresses that have no contract at them, so this script refuses and says so.
 *
 *       The pinned value below is NOT the one in the UniswapV2Router02 deployed at
 *       0xfE126FD0CEcec827112bFc5440d792b3698B3850 on Nurachain. That router was built
 *       when this tree lived at contracts/swap, and carries 0xeb2327179f1be839585a8698
 *       f717f96b9027cacbe0d66bbcf7d98f9f8c6bb2ef. Renaming the folder to contracts/univ2
 *       changed the metadata and therefore the hash. Both are correct — the deployed
 *       factory and router are self-consistent with each other forever, and so is
 *       anything built from this tree — but they are two different builds, and the live
 *       one is reproducible only from ignition/deployments/chain-1020/build-info.
 *
 *       `--sc univ2` against Nurachain is a no-op: the deployment records map the univ2
 *       futures onto those existing addresses, so nothing is redeployed. It is a `--reset`
 *       or a fresh chain that would stand up a new AMM carrying the hash below.
 *
 *   V3  is GENERATED, but it should come out equal to Uniswap's own published constant:
 *       v3-core builds with `metadata.bytecodeHash: "none"`, which leaves the source
 *       paths out of the bytecode entirely, so vendoring the files under contracts/univ3
 *       does not move the hash the way it would for V2. If this script ever writes a
 *       *different* V3 hash, the compiler settings have drifted from upstream — check
 *       V3_SETTINGS and V3_OVERRIDES in hardhat.config.ts before trusting the result.
 */

interface Target {
  /** Name for the log line. */
  readonly name: string;
  /** Compiled artifact whose creation bytecode gets hashed. */
  readonly artifact: string;
  /** Source file carrying the constant. */
  readonly source: string;
  /** Matches the whole constant, including enough context to be unique. */
  readonly pattern: RegExp;
  /** Rebuilds that text around a fresh hash (no 0x prefix). */
  readonly replacement: (hash: string) => string;
  /**
   * Set when the hash is already deployed somewhere that cannot be changed. The script
   * then verifies instead of writing, and a mismatch is a hard error.
   */
  readonly pinned?: { readonly hash: string; readonly because: string };
}

const TARGETS: readonly Target[] = [
  {
    name: "UniswapV2Pair",
    artifact: "artifacts/contracts/univ2/core/UniswapV2Pair.sol/UniswapV2Pair.json",
    source: "contracts/univ2/periphery/libraries/UniswapV2Library.sol",
    pattern: /hex'[0-9a-f]{64}' \/\/ init code hash/,
    replacement: (hash) => `hex'${hash}' // init code hash`,
    pinned: {
      hash: "206906a00400e28bd97b729a655caa755d56148826639b4504155fa9085859d9",
      because:
        "every pair address a UniswapV2Router02 built from this tree computes comes from it, " +
        "and it moves for reasons that have nothing to do with the AMM's logic — see below.",
    },
  },
  {
    name: "UniswapV3Pool",
    artifact: "artifacts/contracts/univ3/core/UniswapV3Pool.sol/UniswapV3Pool.json",
    source: "contracts/univ3/periphery/libraries/PoolAddress.sol",
    pattern: /POOL_INIT_CODE_HASH = 0x[0-9a-f]{64};/,
    replacement: (hash) => `POOL_INIT_CODE_HASH = 0x${hash};`,
  },
];

const root = (relative: string) => fileURLToPath(new URL(`../${relative}`, import.meta.url));

let changed = false;
let failed = false;

for (const target of TARGETS) {
  const artifactPath = root(target.artifact);

  let artifact: { bytecode: string };
  try {
    artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  } catch {
    throw new Error(`No compiled ${target.name} at ${artifactPath}. Run \`hardhat compile\` first.`);
  }

  const hash = keccak256(artifact.bytecode).slice(2);

  if (target.pinned !== undefined && hash !== target.pinned.hash) {
    // Not a "rerun the codegen" situation. Something upstream of here changed the Pair's
    // bytecode — the optimizer settings, the evmVersion, the source path, the profile's
    // `isolated` flag — and the fix is to put that back, not to write a new constant.
    console.error(
      `\n${target.name}: REFUSING to rewrite a pinned hash.\n` +
        `  expected  0x${target.pinned.hash}\n` +
        `  compiled  0x${hash}\n\n` +
        `  This hash cannot move: ${target.pinned.because}\n\n` +
        `  Something changed how ${target.name} compiles. The usual causes are the optimizer\n` +
        `  settings or evmVersion for its solc version in hardhat.config.ts, the \`isolated\`\n` +
        `  flag on a build profile, or the source file moving. Restore that rather than\n` +
        `  accepting a new constant here.`,
    );
    failed = true;
    continue;
  }

  const sourcePath = root(target.source);
  const source = readFileSync(sourcePath, "utf8");

  if (!target.pattern.test(source)) {
    throw new Error(`init code hash constant not found in ${sourcePath}`);
  }

  const patched = source.replace(target.pattern, target.replacement(hash));

  if (patched === source) {
    console.log(`${target.name.padEnd(14)} init code hash already current: 0x${hash}`);
  } else {
    writeFileSync(sourcePath, patched);
    console.log(`${target.name.padEnd(14)} init code hash written:        0x${hash}`);
    changed = true;
  }
}

if (failed) {
  process.exitCode = 1;
} else if (changed) {
  console.log(`\nrecompile so the periphery picks the new constant up`);
}
