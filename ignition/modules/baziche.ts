import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * Everything in contracts/baziche — deployed by `npm run deploy:nurachain:baziche`,
 * or `npx hardhat deploy --sc baziche --network <network>`.
 *
 * Two contracts:
 *
 * - ArcadeAchievements, the ERC-1155 collection the Arcade backend mints rare and legendary
 *   achievements into.
 * - ArcadeVault, which holds the NURA players stake on Arcade's paid tables.
 *
 *   {
 *     "baziche": {
 *       "admin":        "0xYourAdminWallet",
 *       "uri":          "https://your.arcade/api/nft/achievements/{id}.json",
 *       "referee":      "0xTheArcadeServersKey",
 *       "fee":          500,
 *       "maxStake":     "1000000000000000000000n",
 *       "reclaimAfter": 259200
 *     }
 *   }
 *
 * `admin` defaults to the deployer and receives every admin role on both contracts. The
 * backend's relayer wallet still needs MINTER_ROLE granted on the achievements afterwards
 * (`grantRole`), since that key is deliberately not the deployer. `uri` may be left empty and
 * set later with `setURI`.
 *
 * `referee` is the address of the Arcade server's key (its `NURA_REFEREE_KEY`), the only key
 * that can open, pay and refund games. It defaults to the deployer, which is fine for a local
 * chain and a bad idea anywhere real: the deployer would then be the key that says who won.
 * The admin can move the role later with `grantRole` and `revokeRole`. `admin` itself is handed
 * on in two steps: `beginDefaultAdminTransfer(next)`, then `acceptDefaultAdminTransfer()` from
 * the next owner.
 *
 * `fee` is in basis points (500 is 5%, from 100 to 1,500), `maxStake` is the most one player may
 * stake on one game in wei (1,000 NURA by default), and `reclaimAfter` is how many seconds
 * after a game opens anybody may return its stakes if it was never paid (three days by
 * default, between one and thirty). The last one is immutable.
 */
export default buildModule("baziche", (m) => {
  const admin = m.getParameter("admin", m.getAccount(0));
  const uri = m.getParameter("uri", "");
  const referee = m.getParameter("referee", m.getAccount(0));
  const fee = m.getParameter("fee", 500);
  const maxStake = m.getParameter("maxStake", 1_000n * 10n ** 18n);
  const reclaimAfter = m.getParameter("reclaimAfter", 3 * 24 * 60 * 60);

  const achievements = m.contract("ArcadeAchievements", [admin, uri]);
  const vault = m.contract("ArcadeVault", [admin, referee, fee, maxStake, reclaimAfter]);

  return { achievements, vault };
});
