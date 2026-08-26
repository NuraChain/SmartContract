import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { keccak256 } from "ethers";

/**
 * Rewrites the pool init code hash baked into the vendored Uniswap V3 library.
 *
 *   npm run initcodehash        (or: node scripts/write-init-code-hash.ts)
 *
 * The AMM computes a pool's address with CREATE2 arithmetic instead of asking the
 * factory, which takes the keccak256 of the pool's creation bytecode as a compile-time
 * constant — `PoolAddress.computeAddress`. The value Uniswap publishes is the hash of
 * *their* build. Ours can differ: solc appends a metadata hash covering source paths and
 * compiler settings, so a repo with its own layout gets its own hash, and the shipped
 * constant would then send every router call to an address with no contract on it. Every
 * swap and every mint would revert, and nothing about the failure points here.
 *
 * So: compile, hash our own pool, patch the constant, compile again so the periphery
 * picks it up. `npm run build` does all three. test/univ3/Build.test.ts proves the
 * result matches what the factory really deploys.
 *
 * The hash is GENERATED, but it should come out equal to Uniswap's own published
 * constant: v3-core builds with `metadata.bytecodeHash: "none"`, which leaves the source
 * paths out of the bytecode entirely, so vendoring the files under contracts/univ3 does
 * not move it. If this script ever writes a *different* hash, the compiler settings have
 * drifted from upstream — check V3_SETTINGS and V3_OVERRIDES in hardhat.config.ts before
 * trusting the result.
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
}

const TARGETS: readonly Target[] = [
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

for (const target of TARGETS) {
  const artifactPath = root(target.artifact);

  let artifact: { bytecode: string };
  try {
    artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  } catch {
    throw new Error(`No compiled ${target.name} at ${artifactPath}. Run \`hardhat compile\` first.`);
  }

  const hash = keccak256(artifact.bytecode).slice(2);

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

if (changed) {
  console.log(`\nrecompile so the periphery picks the new constant up`);
}
