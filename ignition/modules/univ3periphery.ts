import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import { encodeBytes32String } from "ethers";

/**
 * Redeploys the four V3 periphery contracts that hold a WNURA address, against an
 * EXISTING factory and NFTDescriptor library — deployed by
 * `npm run deploy:nurachain:univ3periphery`, or
 * `npx hardhat deploy --sc univ3periphery --network <network> --parameters <file>`.
 *
 *   NonfungibleTokenPositionDescriptor   (wnura, nativeCurrencyLabel), linked to nftDescriptor
 *   NonfungiblePositionManager           (factory, wnura, descriptor)
 *   SwapRouter                           (factory, wnura)
 *   QuoterV2                             (factory, wnura)
 *
 * WNURA is immutable in all four, so switching wrapped coin means new contracts. The
 * factory, its pools, the NFTDescriptor library and TickLens are reused untouched — use
 * ignition/modules/univ3.ts only to stand up a whole new V3.
 *
 * factory, nftDescriptor and wnura have no defaults on purpose: a wrong address here is
 * a periphery that deploys fine and then reverts on every swap. The Nurachain values live
 * in ignition/parameters/univ3periphery.nurachain.json, which the npm script passes.
 *
 * The factory must be built from the same UniswapV3Pool bytecode as this checkout: the
 * router and position manager compute pool addresses from POOL_INIT_CODE_HASH.
 *
 * Consequences of switching, none of which this module can do for you:
 *   - existing positions stay NFTs in the old position manager and are managed there;
 *   - pools paired with the old WNURA are different pools from new-WNURA pools;
 *   - frontends and SDK configs must move to the four new addresses.
 */
export default buildModule("univ3periphery", (m) => {
  const factory = m.contractAt("UniswapV3Factory", m.getParameter<string>("factory"));
  const nftDescriptor = m.contractAt("NFTDescriptor", m.getParameter<string>("nftDescriptor"));
  const wnura = m.getParameter<string>("wnura");
  const nativeCurrencyLabel = m.getParameter("nativeCurrencyLabel", encodeBytes32String("NURA"));

  const descriptor = m.contract(
    "NonfungibleTokenPositionDescriptor",
    [wnura, nativeCurrencyLabel],
    { libraries: { NFTDescriptor: nftDescriptor } },
  );

  const positionManager = m.contract("NonfungiblePositionManager", [factory, wnura, descriptor]);
  const swapRouter = m.contract("SwapRouter", [factory, wnura]);
  const quoter = m.contract("QuoterV2", [factory, wnura]);

  return { descriptor, positionManager, swapRouter, quoter };
});
