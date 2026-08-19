import { network } from "hardhat";

const { ethers } = await network.getOrCreate();

/**
 * Shared fixtures and V3 arithmetic for test/univ3/**.
 *
 * V3 prices are Q64.96 square roots, not reserve ratios, and ticks are the log base
 * 1.0001 of the price. Nothing here reimplements the contracts' own maths — these are the
 * few conversions a test needs to say "start this pool at 1:1" or "give me a range one
 * tick spacing wide" without hardcoding magic numbers.
 */

// ─── fee tiers ────────────────────────────────────────────────────────────────────────

/** The canonical UniswapV3 fee tiers, in hundredths of a bip, and their tick spacings. */
export const FEE = { LOWEST: 100, LOW: 500, MEDIUM: 3000, HIGH: 10000 } as const;

export const TICK_SPACING: Record<number, number> = {
  [FEE.LOWEST]: 1,
  [FEE.LOW]: 10,
  [FEE.MEDIUM]: 60,
  [FEE.HIGH]: 200,
};

/** Only 500, 3000 and 10000 are enabled by the factory's constructor; 100 is not. */
export const CONSTRUCTOR_FEES = [FEE.LOW, FEE.MEDIUM, FEE.HIGH] as const;

// ─── Q64.96 prices and ticks ──────────────────────────────────────────────────────────

export const Q96 = 2n ** 96n;

/** TickMath.MIN_TICK / MAX_TICK — the pool reverts outside these. */
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;

/** TickMath.MIN_SQRT_RATIO / MAX_SQRT_RATIO. */
export const MIN_SQRT_RATIO = 4295128739n;
export const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;

/** The widest range a pool of this spacing can hold, as the position manager wants it. */
export function fullRange(spacing: number): { tickLower: number; tickUpper: number } {
  return {
    tickLower: Math.ceil(MIN_TICK / spacing) * spacing,
    tickUpper: Math.floor(MAX_TICK / spacing) * spacing,
  };
}

/** Rounds a tick to the nearest usable one for a pool of this spacing. */
export function nearestUsableTick(tick: number, spacing: number): number {
  const rounded = Math.round(tick / spacing) * spacing;
  if (rounded < MIN_TICK) return rounded + spacing;
  if (rounded > MAX_TICK) return rounded - spacing;
  return rounded;
}

/**
 * sqrt(price) * 2^96 for a price expressed as amount1/amount0.
 *
 * Integer square root over a Q192 numerator, so 1:1 comes out as exactly 2^96 rather than
 * a float that rounds to something the pool reads as a different tick.
 */
export function encodeSqrtRatioX96(amount1: bigint, amount0: bigint): bigint {
  return sqrt((amount1 * Q96 * Q96) / amount0);
}

/** Integer square root, Babylonian. */
export function sqrt(value: bigint): bigint {
  if (value < 0n) throw new RangeError("sqrt of negative");
  if (value < 2n) return value;
  let x = value;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }
  return x;
}

/** The tick whose price is closest to (and not above) this sqrt ratio. */
export function tickAtSqrtRatio(sqrtRatioX96: bigint): number {
  // log_1.0001(price) where price = (sqrtRatioX96 / 2^96)^2. Float maths is fine here:
  // this is only ever used to pick a tick to assert against, never to move money.
  const ratio = Number(sqrtRatioX96) / Number(Q96);
  return Math.floor(Math.log(ratio ** 2) / Math.log(1.0001));
}

// ─── multi-hop path encoding ──────────────────────────────────────────────────────────

/**
 * SwapRouter's `Path`: token (20 bytes), fee (3 bytes), token, fee, token...
 * `exactInput` reads it forwards from tokenIn; `exactOutput` reads the same bytes
 * backwards, so its path has to be given reversed.
 */
export function encodePath(tokens: string[], fees: number[]): string {
  if (tokens.length !== fees.length + 1) {
    throw new Error("encodePath: need exactly one fee per hop");
  }
  let path = "0x";
  for (let i = 0; i < fees.length; i++) {
    path += tokens[i].slice(2).toLowerCase() + fees[i].toString(16).padStart(6, "0");
  }
  return path + tokens[tokens.length - 1].slice(2).toLowerCase();
}

// ─── fixtures ─────────────────────────────────────────────────────────────────────────

export const SUPPLY = ethers.parseEther("1000000000");

export async function deadline(): Promise<bigint> {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block!.timestamp) + 3600n;
}

/**
 * The whole V3 deployment plus three ERC20s and WNURA, wired exactly as
 * ignition/modules/univ3.ts wires it — including the 0.01% tier the factory constructor
 * does not enable and the NFTDescriptor library the descriptor links against.
 *
 * Tokens are returned sorted, because V3 orders a pool's tokens by address and half the
 * assertions in these tests are about which side is token0.
 */
export async function deployV3() {
  const [deployer, alice, bob] = await ethers.getSigners();

  const wnura = await ethers.deployContract("WNURA", deployer);

  const factory = await ethers.deployContract("UniswapV3Factory", deployer);
  await factory.enableFeeAmount(FEE.LOWEST, TICK_SPACING[FEE.LOWEST]);

  const nftDescriptor = await ethers.deployContract("NFTDescriptor", deployer);
  const descriptor = await ethers.deployContract(
    "NonfungibleTokenPositionDescriptor",
    [await wnura.getAddress(), ethers.encodeBytes32String("NURA")],
    { signer: deployer, libraries: { NFTDescriptor: await nftDescriptor.getAddress() } },
  );

  const positionManager = await ethers.deployContract(
    "NonfungiblePositionManager",
    [await factory.getAddress(), await wnura.getAddress(), await descriptor.getAddress()],
    deployer,
  );
  const swapRouter = await ethers.deployContract(
    "SwapRouter",
    [await factory.getAddress(), await wnura.getAddress()],
    deployer,
  );
  const quoter = await ethers.deployContract(
    "QuoterV2",
    [await factory.getAddress(), await wnura.getAddress()],
    deployer,
  );
  const tickLens = await ethers.deployContract("TickLens", deployer);
  const callee = await ethers.deployContract("TestUniswapV3Callee", deployer);

  const made = await Promise.all(
    [
      ["Mock Tether USD", "mUSDT"],
      ["Mock Dai", "mDAI"],
      ["Mock Wrapped BTC", "mWBTC"],
    ].map(([name, symbol]) =>
      ethers.deployContract("MockToken", [name, symbol, 18, false], deployer),
    ),
  );

  const withAddress = await Promise.all(
    made.map(async (token) => ({ token, address: await token.getAddress() })),
  );
  withAddress.sort((a, b) => (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1));
  const [tokenA, tokenB, tokenC] = withAddress.map((entry) => entry.token);

  const spenders = await Promise.all(
    [positionManager, swapRouter, callee].map((contract) => contract.getAddress()),
  );

  for (const token of [tokenA, tokenB, tokenC]) {
    for (const who of [deployer, alice, bob]) {
      await token.mint(who.address, SUPPLY);
      for (const spender of spenders) {
        await token.connect(who).approve(spender, ethers.MaxUint256);
      }
    }
  }

  return {
    deployer,
    alice,
    bob,
    wnura,
    factory,
    nftDescriptor,
    descriptor,
    positionManager,
    swapRouter,
    quoter,
    tickLens,
    callee,
    tokenA,
    tokenB,
    tokenC,
  };
}

type V3Context = Awaited<ReturnType<typeof deployV3>>;

/**
 * Creates a pool through the position manager (the way anyone actually does it) and
 * returns it already initialized at the given price.
 */
export async function createPool(
  ctx: V3Context,
  token0: { getAddress(): Promise<string> },
  token1: { getAddress(): Promise<string> },
  fee: number,
  sqrtPriceX96: bigint = Q96,
) {
  const [a, b] = await Promise.all([token0.getAddress(), token1.getAddress()]);
  const [lower, upper] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];

  await ctx.positionManager.createAndInitializePoolIfNecessary(lower, upper, fee, sqrtPriceX96);

  return ethers.getContractAt("UniswapV3Pool", await ctx.factory.getPool(lower, upper, fee));
}

/** Mints a position through the position manager and returns its tokenId. */
export async function mintPosition(
  ctx: V3Context,
  options: {
    token0: { getAddress(): Promise<string> };
    token1: { getAddress(): Promise<string> };
    fee: number;
    tickLower: number;
    tickUpper: number;
    amount0?: bigint;
    amount1?: bigint;
    recipient?: string;
    signer?: (typeof ctx)["deployer"];
  },
): Promise<bigint> {
  const signer = options.signer ?? ctx.deployer;
  const [a, b] = await Promise.all([options.token0.getAddress(), options.token1.getAddress()]);
  const [lower, upper] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];

  const amount0 = options.amount0 ?? ethers.parseEther("1000");
  const amount1 = options.amount1 ?? ethers.parseEther("1000");

  const tokenId = await ctx.positionManager.connect(signer).mint.staticCall({
    token0: lower,
    token1: upper,
    fee: options.fee,
    tickLower: options.tickLower,
    tickUpper: options.tickUpper,
    amount0Desired: amount0,
    amount1Desired: amount1,
    amount0Min: 0n,
    amount1Min: 0n,
    recipient: options.recipient ?? signer.address,
    deadline: await deadline(),
  });

  await ctx.positionManager.connect(signer).mint({
    token0: lower,
    token1: upper,
    fee: options.fee,
    tickLower: options.tickLower,
    tickUpper: options.tickUpper,
    amount0Desired: amount0,
    amount1Desired: amount1,
    amount0Min: 0n,
    amount1Min: 0n,
    recipient: options.recipient ?? signer.address,
    deadline: await deadline(),
  });

  return tokenId[0];
}
