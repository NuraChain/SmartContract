import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import { encodeBytes32String } from "ethers";

/**
 * Everything in contracts/univ3 — deployed by `npm run deploy:nurachain:univ3`,
 * or `npx hardhat deploy --sc univ3 --network <network>`.
 *
 * UniswapV3 — the only AMM this repo ships. It shares the WNURA already live on
 * Nurachain with the router that used to be vendored here; nothing else carries over.
 *
 *   UniswapV3Factory                     creates one pool per (token pair, fee tier)
 *   NFTDescriptor                        library, linked into the descriptor below
 *   NonfungibleTokenPositionDescriptor   draws the position NFT's on-chain SVG
 *   NonfungiblePositionManager           liquidity positions as ERC721 tokens
 *   SwapRouter                           what wallets call: single and multi-hop swaps
 *   QuoterV2                             quotes, by simulating a swap and reverting
 *   TickLens                             bulk tick reads, for depth charts
 *
 * Pools are not deployed here, and neither is WNURA or Multicall3 — see below.
 *
 * ─── never pass --reset ──────────────────────────────────────────────────────────────
 *
 * Ignition keys a deployment by chain id, so this module writes into the same
 * ignition/deployments/chain-1020/ folder that already holds the LIVE earlier
 * deployments. `--reset` wipes that folder. Those contracts stay deployed, but the
 * record of where they are does not, and `ignition/deployments/` is gitignored.
 * Back it up before deploying if you value it.
 *
 * ─── after deploying ─────────────────────────────────────────────────────────────────
 *
 * `UniswapV3Factory` takes no constructor argument: it sets `owner` to whoever deployed
 * it. That key can enable new fee tiers and switch on the protocol's cut of swap fees
 * (up to 1/4), so on anything real it belongs to a multisig. Deliberately NOT done here
 * — handing away control is not a thing to do as a side effect of a deploy script:
 *
 *   factory.setOwner(multisig)
 *
 * The same argument applies to any earlier deployment's admin keys, which are still
 * the deployer EOA.
 */
export default buildModule("univ3", (m) => {
  // Nurachain already has a wrapped native coin — WNURA, deployed when the V2 AMM that
  // used to be vendored here went live. V3 periphery needs that contract, not a second
  // one — two wrapped NURAs would split every native pool in half. Verified
  // IWETH9-compatible: deposit(), withdraw(), and the ERC20 surface are all present.
  //
  // Override for a different chain with --parameters:
  //   { "v3": { "wnura": "0x..." } }
  const wnura = m.getParameter("wnura", "0xf0a4eC07916feBa4432121Ed5969887D9b939cD0");

  // Shown on the position NFT in place of "ETH". Read back by nativeCurrencyLabel(),
  // which stops at the first zero byte, so a right-padded bytes32 is what it wants.
  const nativeCurrencyLabel = m.getParameter("nativeCurrencyLabel", encodeBytes32String("NURA"));

  const factory = m.contract("UniswapV3Factory");

  // The constructor enables 0.05%/10, 0.30%/60 and 1.00%/200. The 0.01% tier is the one
  // canonical tier it leaves out, and stablecoin pairs want it, so switch it on here.
  //
  // Tick spacing is not a free parameter — spacing s means positions snap to
  // 1.0001^(k*s) price boundaries, so tighter spacing buys finer ranges at the cost of
  // more ticks crossed per swap. 100/1 is the pairing every V3 SDK, subgraph and router
  // assumes. enableFeeAmount is also one-way: a tier can never be removed, and its
  // spacing can never be changed. Getting the number right matters more than usual.
  m.call(factory, "enableFeeAmount", [100, 1]);

  // 24541 bytes against Nurachain's 24576 limit — 35 to spare, which is why
  // hardhat.config.ts pins this file to 1000 optimizer runs and bytecodeHash "none".
  // Deployed standalone rather than inlined because its functions are `public`.
  const nftDescriptor = m.library("NFTDescriptor");

  const descriptor = m.contract(
    "NonfungibleTokenPositionDescriptor",
    [wnura, nativeCurrencyLabel],
    { libraries: { NFTDescriptor: nftDescriptor } },
  );

  const positionManager = m.contract("NonfungiblePositionManager", [factory, wnura, descriptor]);
  const swapRouter = m.contract("SwapRouter", [factory, wnura]);
  const quoter = m.contract("QuoterV2", [factory, wnura]);
  const tickLens = m.contract("TickLens");

  // Not deployed here, on purpose:
  //
  //   WNURA       already live at the address above.
  //   Multicall3  already live at 0xf58884FCf45d8F5Cc8A73c618D23EB27b732CA24, and it is
  //               chain-wide infrastructure, not a V3 contract. The `Multicall` that V3
  //               periphery ships is a base contract the router and position manager
  //               inherit — it batches calls to themselves and is never deployed alone.
  //   Pools       created on demand by
  //               positionManager.createAndInitializePoolIfNecessary(t0, t1, fee, sqrtPriceX96).
  //   V3Migrator  moves V2 LP into V3. The only V2 pair on this chain holds dust, so
  //               there is nothing to migrate. Add it if that changes.
  return { factory, nftDescriptor, descriptor, positionManager, swapRouter, quoter, tickLens };
});
