import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * Everything in contracts/token — deployed by `npm run deploy:nurachain:token`,
 * or `npx hardhat deploy --sc token --network <network>`.
 *
 * The admin defaults to the deploying account. To hand the roles to a multisig
 * instead, put this in ignition/params.json and pass --parameters:
 *
 *   { "token": { "admin": "0xYourMultisig" } }
 */
export default buildModule("token", (m) => {
  const admin = m.getParameter("admin", m.getAccount(0));

  const bridgeUSDT = m.contract("BridgeUSDT", [admin]);
  const bridgeBNB = m.contract("BridgeBNB", [admin]);

  return { bridgeUSDT, bridgeBNB };
});
