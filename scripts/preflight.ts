import { artifacts, network } from "hardhat";

/**
 * Pre-deployment sanity check for a chain you have not deployed to before.
 *
 *   npx hardhat run scripts/preflight.ts --network nurachain
 *
 * Confirms the RPC answers, that the chain id is what you expect, that the deployer
 * is funded, and — via a real gas estimate against the node — that this bytecode can
 * actually execute there. The gas estimate is the important one: it runs each
 * constructor on the node, so it fails loudly if the chain lacks the Cancun opcodes
 * this build targets, instead of you finding out by burning gas on a failed deploy.
 *
 * This checks every deployable group, not just the one you are about to deploy —
 * a preflight is cheap and finding out about the second group later is not.
 */

/**
 * Representative constructor args per contract, only used to estimate gas. The
 * airdrop's real cap and reward are answered at deploy time; constructor gas does not
 * depend on what they are, only that they are non-zero.
 */
function probes(deployer: string) {
  return {
    token: [
      { name: "BridgeUSDT", args: [deployer] },
      { name: "BridgeBNB", args: [deployer] },
    ],
    airdrop: [
      { name: "Airdrop", args: [deployer, deployer, 50_000n, 200n * 10n ** 18n] },
    ],
    // The AMM is the expensive group by a wide margin — the Pair bytecode the factory
    // carries is most of it. Estimating the router against a factory address that is
    // not a contract yet is fine: the constructor only stores it.
    univ2: [
      { name: "WNURA", args: [] },
      { name: "UniswapV2Factory", args: [deployer] },
      { name: "UniswapV2Router02", args: [deployer, deployer] },
      { name: "Multicall3", args: [] },
    ],
    // univ3 reuses the deployed WNURA and Multicall3, so neither is here. Every constructor
    // below only stores its arguments, which is why passing the deployer's address for
    // all of them estimates the same gas the real deployment will use.
    univ3: [
      { name: "UniswapV3Factory", args: [] },
      { name: "NFTDescriptor", args: [] },
      { name: "NonfungibleTokenPositionDescriptor", args: [deployer, NURA_LABEL] },
      { name: "NonfungiblePositionManager", args: [deployer, deployer, deployer] },
      { name: "SwapRouter", args: [deployer, deployer] },
      { name: "QuoterV2", args: [deployer, deployer] },
      { name: "TickLens", args: [] },
    ],
    // The backing token address is only stored, so the deployer's own address estimates the
    // same gas the real deployment will. The real one comes from ignition/params.json.
    vault: [
      {
        name: "CollateralizedNFT",
        args: [deployer, deployer, 250n * 10n ** 18n, "Backed Position", "BPOS", ""],
      },
    ],
  };
}

/** bytes32("NURA") — what ignition/modules/univ3.ts passes to the descriptor. */
const NURA_LABEL = "0x4e55524100000000000000000000000000000000000000000000000000000000";

/** EIP-170. Verified against Nurachain: 24576 deploys, 24577 is rejected by the node. */
const MAX_CODE_SIZE = 24576;

/**
 * NonfungibleTokenPositionDescriptor links NFTDescriptor at deploy time, so its bytecode
 * has an unresolved placeholder until an address is supplied. Any address estimates the
 * same gas — the library is only ever `delegatecall`ed, never read at construction.
 */
const LIBRARY_LINKED = new Set(["NonfungibleTokenPositionDescriptor"]);

async function main() {
  const { ethers, networkName, networkConfig } = await network.getOrCreate();

  console.log(`Network:        ${networkName}`);

  const net = await ethers.provider.getNetwork();
  console.log(`Chain ID:       ${net.chainId}`);

  const expected = (networkConfig as { chainId?: number }).chainId;
  if (expected === undefined) {
    console.log(`                (no chainId pinned in hardhat.config.ts)`);
  } else if (BigInt(expected) !== net.chainId) {
    throw new Error(`Chain ID mismatch: config says ${expected}, RPC says ${net.chainId}`);
  }

  const block = await ethers.provider.getBlock("latest");
  console.log(`Latest block:   ${block?.number}`);
  // Chains that shipped EIP-4844 expose these. Only a hint about Cancun support —
  // the gas estimates below are the real test.
  const cancunHint = block !== null && "excessBlobGas" in block && block.excessBlobGas !== null;
  console.log(`Cancun hint:    ${cancunHint ? "blob fields present" : "no blob fields"}`);

  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Deployer:       ${deployer.address}`);
  console.log(`Balance:        ${ethers.formatEther(balance)} (native)`);

  const feeData = await ethers.provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas ?? 0n;
  console.log(`Gas price:      ${ethers.formatUnits(gasPrice, "gwei")} gwei`);

  // Nurachain enforces EIP-170 exactly, and the V3 contracts were built with 35 to 41
  // bytes to spare. A contract over the limit fails at deploy time with a bare revert, so
  // it is worth catching here — and worth printing the margin even when it passes, since
  // that margin is the thing a compiler-settings change silently spends.
  const oversized: string[] = [];

  let totalGas = 0n;
  for (const [group, contracts] of Object.entries(probes(deployer.address))) {
    console.log(`\ncontracts/${group}`);
    for (const { name, args } of contracts) {
      const factory = await ethers.getContractFactory(
        name,
        LIBRARY_LINKED.has(name)
          ? { libraries: { NFTDescriptor: deployer.address }, signer: deployer }
          : deployer,
      );

      // EIP-170 caps the RUNTIME code, which is what the artifact calls deployedBytecode
      // — the creation bytecode is longer and is not what the limit applies to.
      const { deployedBytecode } = await artifacts.readArtifact(name);
      const size = (deployedBytecode.length - 2) / 2;

      const tx = await factory.getDeployTransaction(...args);
      const gas = await ethers.provider.estimateGas({ ...tx, from: deployer.address });
      totalGas += gas;

      const spare = MAX_CODE_SIZE - size;
      const margin = spare < 0 ? `OVER by ${-spare}` : `${spare} spare`;
      console.log(
        `  ${name.padEnd(36)} ${String(gas).padStart(9)} gas  ${String(size).padStart(5)} bytes, ${margin}`,
      );

      if (spare < 0) {
        oversized.push(name);
      }
    }
  }

  if (oversized.length > 0) {
    throw new Error(
      `Over Nurachain's ${MAX_CODE_SIZE}-byte contract size limit: ${oversized.join(", ")}. ` +
        `Check the optimizer runs and metadata.bytecodeHash settings in hardhat.config.ts.`,
    );
  }

  const cost = totalGas * gasPrice;
  console.log(`\nDeploy cost:    ${ethers.formatEther(cost)} (native) for everything`);

  if (balance < cost) {
    throw new Error(
      `Deployer is underfunded: has ${ethers.formatEther(balance)}, needs ~${ethers.formatEther(cost)}`,
    );
  }

  // The airdrop pays out of its own balance, so deployment cost is not the real bill.
  // The cap and reward are chosen at deploy time, so the pool is only known then —
  // set AIRDROP_MAX_CLAIMS and AIRDROP_REWARD (in whole coin) to price one here.
  const maxClaims = process.env.AIRDROP_MAX_CLAIMS;
  const reward = process.env.AIRDROP_REWARD;

  if (maxClaims !== undefined && reward !== undefined) {
    const pool = BigInt(maxClaims) * ethers.parseEther(reward);
    const claims = BigInt(maxClaims).toLocaleString("en-US");
    console.log(`Airdrop pool:   ${ethers.formatEther(pool)} (native) to cover ${claims} claims at ${reward} each,`);
    console.log(`                sent to the Airdrop address after deployment — not included above.`);
  } else {
    console.log(`Airdrop pool:   maxClaims * rewardAmount, both answered when you run`);
    console.log(`                \`hardhat deploy --sc airdrop\`, and sent to the Airdrop address`);
    console.log(`                afterwards — not included above. Set AIRDROP_MAX_CLAIMS and`);
    console.log(`                AIRDROP_REWARD to price a cap here.`);
  }

  console.log(`\nReady to deploy.`);
}

main().catch((error) => {
  console.error(`\nPreflight failed:`, error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
