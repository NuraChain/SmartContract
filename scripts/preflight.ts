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
      { name: "BridgeETH", args: [deployer] },
      { name: "BridgeBTC", args: [deployer] },
    ],
    airdrop: [
      { name: "Airdrop", args: [deployer, deployer, 50_000n, 200n * 10n ** 18n] },
    ],
    // WNURA and Multicall3 are already live on Nurachain, so neither is probed here.
    // Every constructor below only stores its arguments, which is why passing the
    // deployer's address for all of them estimates the same gas the real deployment will use.
    univ3: [
      { name: "UniswapV3Factory", args: [] },
      { name: "NFTDescriptor", args: [] },
      { name: "NonfungibleTokenPositionDescriptor", args: [deployer, NURA_LABEL] },
      { name: "NonfungiblePositionManager", args: [deployer, deployer, deployer] },
      { name: "SwapRouter", args: [deployer, deployer] },
      { name: "QuoterV2", args: [deployer, deployer] },
      { name: "TickLens", args: [] },
    ],
    // The proxy is not probed: its constructor delegatecalls `initialize` into the
    // implementation, so it can only be estimated against a real implementation address.
    // The lens and verifier only store the addresses they are given.
    profile: [
      { name: "NuraForwarder", args: [] },
      { name: "NuraProfile", args: [deployer] },
      { name: "NuraProfileLens", args: [deployer] },
      { name: "SocialVerifier", args: [deployer, deployer, deployer] },
    ],
    // The vault's referee, fee, ceiling and wait are deploy parameters, and its constructor
    // only checks and stores them, so these estimate the gas the real ones will.
    baziche: [
      { name: "ArcadeAchievements", args: [deployer, ""] },
      { name: "ArcadeVault", args: [deployer, deployer, 500, 2_000, 1_000n * 10n ** 18n, 3n * 24n * 60n * 60n] },
    ],
    // The shop's seller and inviters' share are deploy parameters, only checked and stored.
    bazicheshop: [
      { name: "ArcadeShop", args: [deployer, deployer, 1_000] },
    ],
    // The gifts' contract takes its owner and nothing else.
    bazichetips: [
      { name: "ArcadeTips", args: [deployer] },
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

/**
 * What the Arcade server's referee spends on one paid game of nine seats, the most a game holds:
 * `open` and `settle` as the vault's own tests measure them.
 */
const OPEN_GAS_NINE = 943_000n;
const SETTLE_GAS_NINE = 114_000n;

/** The most one `buy` costs, with an inviter to credit, as the shop's own tests measure it. */
const BUY_GAS_INVITED = 180_000n;

/** Arcade's referee never pays less than this on Nurachain (its NURA_GAS_FLOOR). */
const REFEREE_FLOOR = 47_000_000_000n;

/** The sizes of table Arcade plays for NURA, from two seats to nine. */
const TABLE_SIZES = [2, 3, 4, 6, 9];

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

  // Arcade's paid tables ask three more things of the chain, and each has been wrong once
  // somewhere: how often a block comes, what the referee pays for gas, and whether the node
  // takes the requests the referee sends. Nurachain's rpc once dropped request bodies over
  // about 1.2 KB, and a nine-seat `open` is several times that. Each request is sent as an
  // eth_call to the deployer's own address, which holds no code, so all it can say is whether
  // the node took a request that size.
  console.log(`\nArcade's paid tables`);

  const newest = await ethers.provider.getBlock("latest");
  const span = Math.min(100, newest?.number ?? 0);
  const older = await ethers.provider.getBlock((newest?.number ?? 0) - span);
  const spacing = newest === null || older === null || span === 0 ? 0 : (newest.timestamp - older.timestamp) / span;
  const age = newest === null ? 0 : Math.floor(Date.now() / 1000) - newest.timestamp;
  console.log(`  Block time:     ${spacing.toFixed(1)} s over the last ${span} blocks, the newest ${age} s old`);

  const refereePrice = gasPrice > REFEREE_FLOOR ? gasPrice : REFEREE_FLOOR;
  console.log(`  Referee gas:    ${ethers.formatUnits(refereePrice, "gwei")} gwei (Arcade never pays under 47)`);
  console.log(`  One game:       ${ethers.formatEther((OPEN_GAS_NINE + SETTLE_GAS_NINE) * refereePrice)} (native) to lock and pay nine seats`);

  const vault = (await ethers.getContractFactory("ArcadeVault")).interface;
  const id = ethers.zeroPadValue("0x01", 32);
  const refused: string[] = [];

  for (const seats of TABLE_SIZES) {
    const standIns = Array.from({ length: seats }, (_, index) => ({
      player: deployer.address,
      commit: ethers.zeroPadValue(ethers.toBeHex(index + 1), 32),
      nonce: ethers.zeroPadValue(ethers.toBeHex(index + 100), 32),
      deadline: 2n ** 63n,
      signature: `0x${"ab".repeat(65)}`,
    }));
    const requests = [
      ["open", vault.encodeFunctionData("open", [id, "poker", 10n ** 18n, 500, standIns])],
      ["settle", vault.encodeFunctionData("settle", [id, 1n, standIns.map((seat) => seat.commit)])],
    ] as const;

    for (const [name, data] of requests) {
      const bytes = (data.length - 2) / 2;
      const label = `  ${name} at ${seats}:`.padEnd(18);

      try {
        await ethers.provider.call({ to: deployer.address, data });
        console.log(`${label}${String(bytes).padStart(6)} bytes, taken`);
      } catch (error) {
        refused.push(`${name} at ${seats} seats (${bytes} bytes)`);
        console.log(`${label}${String(bytes).padStart(6)} bytes, REFUSED: ${error instanceof Error ? error.message.split("\n")[0] : error}`);
      }
    }
  }

  if (refused.length > 0) {
    throw new Error(
      `The node would not take ${refused.join(", ")}, so Arcade's referee could not lock or pay ` +
        `games that large there. Raise the rpc's request size limit before paid tables open.`,
    );
  }

  // A sale in Arcade's shop is one `buy` from the buyer's own wallet: a quote and the seller's
  // signature, sent the same way, and the gas the buyer pays for it at the floor.
  console.log(`\nArcade's shop`);
  const shop = (await ethers.getContractFactory("ArcadeShop")).interface;
  const quote = {
    order: id,
    buyer: deployer.address,
    item: id,
    price: 10n ** 18n,
    referrer: deployer.address,
    deadline: 2n ** 63n,
  };
  const sale = shop.encodeFunctionData("buy", [quote, `0x${"ab".repeat(65)}`]);
  const saleBytes = (sale.length - 2) / 2;
  try {
    await ethers.provider.call({ to: deployer.address, data: sale });
    console.log(`  buy:            ${String(saleBytes).padStart(6)} bytes, taken`);
  } catch (error) {
    throw new Error(
      `The node would not take a ${saleBytes}-byte buy (${error instanceof Error ? error.message.split("\n")[0] : error}), ` +
        `so nobody could pay Arcade's shop there.`,
    );
  }
  console.log(`  One sale:       ${ethers.formatEther(BUY_GAS_INVITED * refereePrice)} (native) of gas at most, paid by the buyer`);

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
