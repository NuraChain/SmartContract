import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { keccak256 } from "ethers";

/**
 * Rewrites the pair init code hash baked into the vendored UniswapV2Library.
 *
 *   npm run initcodehash        (or: node scripts/write-init-code-hash.ts)
 *
 * `UniswapV2Library.pairFor` computes a pair's address with CREATE2 arithmetic instead
 * of asking the factory, which takes the keccak256 of the Pair creation bytecode as a
 * constant. The value Uniswap publishes is the hash of *their* build of the Pair. Ours
 * differs â€” solc appends a metadata hash covering the source paths and compiler
 * settings, and this repo has its own â€” so the shipped constant would send every router
 * call to an address with no contract on it. Every swap and every addLiquidity would
 * revert, and nothing about the failure points here.
 *
 * So: compile, hash our own Pair, patch the constant, compile again so the periphery
 * picks it up. `npm run build` does all three. test/UniV2.test.ts proves the result
 * matches what the factory really deploys.
 */

const artifactPath = fileURLToPath(
  new URL("../artifacts/contracts/univ2/core/UniswapV2Pair.sol/UniswapV2Pair.json", import.meta.url),
);
const libraryPath = fileURLToPath(
  new URL("../contracts/univ2/periphery/libraries/UniswapV2Library.sol", import.meta.url),
);

let artifact: { bytecode: string };
try {
  artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
} catch {
  throw new Error(`No compiled Pair at ${artifactPath}. Run \`hardhat compile\` first.`);
}

const hash = keccak256(artifact.bytecode).slice(2);

const source = readFileSync(libraryPath, "utf8");
const pattern = /hex'[0-9a-f]{64}' \/\/ init code hash/;

if (!pattern.test(source)) {
  throw new Error(`init code hash constant not found in ${libraryPath}`);
}

const patched = source.replace(pattern, `hex'${hash}' // init code hash`);

if (patched === source) {
  console.log(`init code hash already current: 0x${hash}`);
} else {
  writeFileSync(libraryPath, patched);
  console.log(`init code hash written: 0x${hash}`);
  console.log(`recompile so contracts/univ2/periphery picks it up`);
}
