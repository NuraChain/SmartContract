import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * ArcadeLooks alone, from contracts/baziche - deployed by `npm run deploy:nurachain:bazichelooks`,
 * or `npx hardhat deploy --sc bazichelooks --network <network>`. A group of its own so that a
 * chain which already holds the vault, the achievements and the shop is not given a second of each.
 *
 *   {
 *     "bazichelooks": {
 *       "admin": "0xYourAdminWallet",
 *       "uri":   "https://baziche.com/api/nft/looks/{id}.json"
 *     }
 *   }
 *
 * `admin` defaults to the deployer and receives DEFAULT_ADMIN_ROLE; it is handed on in two steps,
 * `beginDefaultAdminTransfer(next)` then `acceptDefaultAdminTransfer()`. `uri` is the metadata
 * template the Arcade server answers, and may be set later with `setURI`.
 *
 * The Arcade server's minter wallet (its `NURA_MINTER_KEY`) still needs MINTER_ROLE granted
 * afterwards, by the admin: `grantRole(MINTER_ROLE, minter)`. It is deliberately not the deployer,
 * nor the key that pays out tables and signs the shop's quotes.
 */
export default buildModule("bazichelooks", (m) => {
  const admin = m.getParameter("admin", m.getAccount(0));
  const uri = m.getParameter("uri", "");

  const looks = m.contract("ArcadeLooks", [admin, uri]);

  return { looks };
});
