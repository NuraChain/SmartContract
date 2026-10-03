import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * Everything in contracts/arcade — deployed by `npm run deploy:nurachain:arcade`,
 * or `npx hardhat deploy --sc arcade --network <network>`.
 *
 * One contract: ArcadeAchievements, the ERC-1155 collection the Arcade backend mints
 * rare and legendary achievements into.
 *
 *   {
 *     "arcade": {
 *       "admin": "0xYourAdminWallet",
 *       "uri":   "https://your.arcade/api/nft/achievements/{id}.json"
 *     }
 *   }
 *
 * `admin` defaults to the deployer and receives DEFAULT_ADMIN_ROLE and MINTER_ROLE. The
 * backend's relayer wallet still needs MINTER_ROLE granted afterwards (`grantRole`), since
 * that key is deliberately not the deployer. `uri` may be left empty and set later with
 * `setURI`.
 */
export default buildModule("arcade", (m) => {
  const admin = m.getParameter("admin", m.getAccount(0));
  const uri = m.getParameter("uri", "");

  const achievements = m.contract("ArcadeAchievements", [admin, uri]);

  return { achievements };
});
