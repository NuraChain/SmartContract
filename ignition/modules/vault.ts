import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * Everything in contracts/vault — deployed by `npm run deploy:nurachain:vault`,
 * or `npx hardhat deploy --sc vault --network <network>`.
 *
 * One contract: CollateralizedNFT, an ERC721 whose every token is a claim on a fixed
 * amount of an ERC20 this contract holds.
 *
 * `token` has no default, and cannot have one. It is the address of an ERC20 that already
 * exists on the target chain, it is immutable once this constructor runs, and a wrong value
 * produces a contract that can never pay anybody. Put it in ignition/params.json and pass
 * --parameters:
 *
 *   npx hardhat deploy --sc vault --network nurachain --parameters ./ignition/params.json
 *
 *   {
 *     "vault": {
 *       "token":      "0xTheERC20AlreadyDeployedOnNurachain",
 *       "admin":      "0xYourMultisig",
 *       "lockAmount": "250000000000000000000n",
 *       "name":       "Backed Position",
 *       "symbol":     "BPOS",
 *       "baseURI":    "https://your.api/vault/"
 *     }
 *   }
 *
 * `lockAmount` is in the token's own decimals, and the default of 250e18 assumes 18 of them —
 * which is what contracts/token uses. On a 6-decimal token the same 250 tokens is 250000000,
 * and passing the default instead would reserve 250 trillion tokens per NFT and back nothing.
 * scripts/vault-setup.ts checks this against the token's real `decimals()` and says so.
 *
 * Like ignition/modules/airdrop.ts, this module deploys and stops: it does not move the
 * 2,500,000 token reserve in. Funding needs an allowance from whoever holds the tokens, which
 * is not necessarily the deployer and is often a multisig signing separately. Run
 *
 *   npx hardhat run scripts/vault-setup.ts --network nurachain
 *
 * afterwards to fund the contract and print the resulting state. Until it is funded the
 * contract is live but has no capacity, and `mint` reverts with InsufficientBacking.
 *
 * `admin` defaults to the deployer and receives DEFAULT_ADMIN_ROLE and MINTER_ROLE. Public
 * minting starts off, so only MINTER_ROLE can mint until an admin calls
 * `setPublicMintEnabled(true)` — read the note on that function before doing so, because
 * minting is free and every NFT is redeemable for real tokens.
 */
export default buildModule("vault", (m) => {
  const token = m.getParameter<string>("token");
  const admin = m.getParameter("admin", m.getAccount(0));
  const lockAmount = m.getParameter<bigint>("lockAmount", 250n * 10n ** 18n);
  const name = m.getParameter("name", "Backed Position");
  const symbol = m.getParameter("symbol", "BPOS");
  const baseURI = m.getParameter("baseURI", "");

  const vault = m.contract("CollateralizedNFT", [
    admin,
    token,
    lockAmount,
    name,
    symbol,
    baseURI,
  ]);

  return { vault };
});
