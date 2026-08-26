import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.getOrCreate();

/**
 * What the build itself has to get right, before any contract logic is worth testing.
 *
 * Two things can make a perfectly correct V3 undeployable or inert on Nurachain, and
 * neither shows up as a failing swap — they show up as a deploy that reverts, or as a
 * router that computes addresses with no contract at them:
 *
 *   1. EIP-170. Nurachain enforces a 24576-byte contract size limit, verified against the
 *      node: a simulated deploy of 24576 bytes succeeds and 24577 returns
 *      "max code size exceeded: code size 24577 limit 24576". UniswapV3Factory compiles to
 *      24535 and NFTDescriptor to 24541. That is 41 and 35 bytes of headroom, and
 *      `metadata.bytecodeHash: "none"` is worth about 40 of them by itself.
 *
 *   2. The init code hash. The AMM derives pool addresses with CREATE2 arithmetic over
 *      a hardcoded hash of the pool's creation bytecode.
 *
 * These run first because a wrong hash makes every other test in test/univ3 fail for one
 * reason, and a size overrun fails only at deploy time on a real chain.
 */

const EIP170_LIMIT = 24576;

const artifact = (path: string) =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../artifacts/contracts/${path}`, import.meta.url)), "utf8"),
  ) as { bytecode: string; deployedBytecode: string };

/** Everything contracts/univ3 actually puts on-chain, plus the pool the factory deploys. */
const DEPLOYED = [
  ["UniswapV3Factory", "univ3/core/UniswapV3Factory.sol/UniswapV3Factory.json"],
  ["UniswapV3Pool", "univ3/core/UniswapV3Pool.sol/UniswapV3Pool.json"],
  ["NFTDescriptor", "univ3/periphery/libraries/NFTDescriptor.sol/NFTDescriptor.json"],
  [
    "NonfungibleTokenPositionDescriptor",
    "univ3/periphery/NonfungibleTokenPositionDescriptor.sol/NonfungibleTokenPositionDescriptor.json",
  ],
  [
    "NonfungiblePositionManager",
    "univ3/periphery/NonfungiblePositionManager.sol/NonfungiblePositionManager.json",
  ],
  ["SwapRouter", "univ3/periphery/SwapRouter.sol/SwapRouter.json"],
  ["QuoterV2", "univ3/periphery/lens/QuoterV2.sol/QuoterV2.json"],
  ["TickLens", "univ3/periphery/lens/TickLens.sol/TickLens.json"],
] as const;

/**
 * Uniswap's own published constant. Ours should equal it: v3-core builds with
 * `metadata.bytecodeHash: "none"`, so the bytecode carries no hash of the source paths
 * and vendoring the files under contracts/univ3 does not move it. Equality is therefore a
 * byte-level proof that the vendored source and the compiler settings both match
 * upstream — which is exactly what the 41 bytes of factory headroom depend on.
 */
const CANONICAL_POOL_INIT_CODE_HASH =
  "0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54";

describe("V3 build", () => {
  describe("contract size against Nurachain's EIP-170 limit", () => {
    for (const [name, path] of DEPLOYED) {
      it(`${name} fits in ${EIP170_LIMIT} bytes`, () => {
        const size = (artifact(path).deployedBytecode.length - 2) / 2;

        expect(
          size,
          `${name} is ${size} bytes, ${size - EIP170_LIMIT} over the limit. ` +
            `Check V3_SETTINGS and V3_OVERRIDES in hardhat.config.ts — optimizer runs and ` +
            `metadata.bytecodeHash "none" are what make this fit.`,
        ).to.be.at.most(EIP170_LIMIT);
      });
    }

    // Not a size assertion so much as a tripwire. These two have double-digit headroom,
    // so anything that silently inflates them is worth knowing about before it lands on
    // the wrong side of the limit.
    it("reports the headroom left on the two contracts that barely fit", () => {
      const report = (["UniswapV3Factory", "NFTDescriptor"] as const).map((name) => {
        const path = DEPLOYED.find(([n]) => n === name)![1];
        const size = (artifact(path).deployedBytecode.length - 2) / 2;
        return `${name}: ${size} bytes, ${EIP170_LIMIT - size} spare`;
      });

      console.log(`        ${report.join("\n        ")}`);
      expect(report).to.have.lengthOf(2);
    });
  });

  describe("pool init code hash", () => {
    it("matches the constant PoolAddress hardcodes", () => {
      // PoolAddress.computeAddress, and therefore CallbackValidation.verifyCallback and
      // every SwapRouter and NonfungiblePositionManager entry point, derives the pool
      // address from this constant. Stale, and all of them revert.
      const compiled = ethers.keccak256(artifact(DEPLOYED[1][1]).bytecode);
      const source = readFileSync(
        fileURLToPath(new URL("../../contracts/univ3/periphery/libraries/PoolAddress.sol", import.meta.url)),
        "utf8",
      );

      const constant = /POOL_INIT_CODE_HASH = (0x[0-9a-f]{64});/.exec(source);

      expect(constant, "POOL_INIT_CODE_HASH not found in PoolAddress.sol").to.not.equal(null);
      expect(
        constant![1],
        "run `npm run initcodehash` and recompile",
      ).to.equal(compiled);
    });

    it("reproduces Uniswap's own published constant", () => {
      expect(
        ethers.keccak256(artifact(DEPLOYED[1][1]).bytecode),
        "our UniswapV3Pool bytecode differs from upstream's. The vendored source or the " +
          "0.7.6 compiler settings have drifted — check contracts/univ3/VENDORED.md.",
      ).to.equal(CANONICAL_POOL_INIT_CODE_HASH);
    });

    it("puts a pool exactly where CREATE2 on our Pool bytecode says", async () => {
      // The same arithmetic PoolAddress does, done here in TypeScript against the real
      // factory. This is the end-to-end version of the two assertions above.
      const { deployV3, FEE } = await import("./helpers.ts");
      const ctx = await deployV3();

      const [a, b] = await Promise.all([ctx.tokenA.getAddress(), ctx.tokenB.getAddress()]);
      await ctx.factory.createPool(a, b, FEE.MEDIUM);

      const salt = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["address", "address", "uint24"], [a, b, FEE.MEDIUM]),
      );
      const predicted = ethers.getCreate2Address(
        await ctx.factory.getAddress(),
        salt,
        CANONICAL_POOL_INIT_CODE_HASH,
      );

      expect(await ctx.factory.getPool(a, b, FEE.MEDIUM)).to.equal(predicted);
    });
  });
});
