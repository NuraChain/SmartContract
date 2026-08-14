import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * Deploys both bridged tokens with the same admin.
 *
 * The admin defaults to the deploying account. To hand the roles to a multisig
 * instead, pass it as a parameter:
 *
 *   hardhat ignition deploy ignition/modules/BridgeTokens.ts \
 *     --network bscTestnet --parameters ./ignition/params.json
 *
 * where params.json is: { "BridgeTokens": { "admin": "0xYourMultisig" } }
 */
export default buildModule("BridgeTokens", (m) => {
  const admin = m.getParameter("admin", m.getAccount(0));

  const bridgeUSDT = m.contract("BridgeUSDT", [admin]);
  const bridgeBNB = m.contract("BridgeBNB", [admin]);

  return { bridgeUSDT, bridgeBNB };
});
