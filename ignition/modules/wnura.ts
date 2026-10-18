import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * contracts/token/WNURA.sol on its own — deployed by `npm run deploy:nurachain:wnura`,
 * or `npx hardhat deploy --sc wnura --network <network>`.
 *
 * Kept out of the token module so redeploying the bridge tokens never mints a second
 * wrapped coin as a side effect. WNURA takes no constructor arguments and has no admin.
 *
 * Nurachain already has a canonical WNURA at 0xf0a4eC07916feBa4432121Ed5969887D9b939cD0,
 * and ignition/modules/univ3.ts defaults to it. Deploying this gives a NEW, separate
 * WNURA; to point V3 at it, pass its address as { "v3": { "wnura": "0x..." } }.
 */
export default buildModule("wnura", (m) => {
  const wnura = m.contract("WNURA");

  return { wnura };
});
