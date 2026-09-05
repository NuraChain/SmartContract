// The contract registry - the SINGLE SOURCE OF TRUTH for everything this
// application can talk to. No component hardcodes an address or an ABI; they
// read this file.
//
// Entries mirror the contracts repository (C:/Users/Alex/Desktop/Smart
// Contract): each ABI is the compiled artifact from that repo's
// artifacts/contracts tree, refreshed by `node scripts/extract-abi.mjs`.
//
// An entry with `address: null` is a supported contract whose deployment this
// repository has no address on record for. It is listed honestly as such -
// never guessed, never faked. When a deployment lands, record its address here.

import type { Abi, Address } from 'viem';

import AirdropAbi from './abi/Airdrop.json';
import BridgeBnbAbi from './abi/BridgeBNB.json';
import BridgeUsdtAbi from './abi/BridgeUSDT.json';
import CollateralizedNftAbi from './abi/CollateralizedNFT.json';
import Multicall3Abi from './abi/Multicall3.json';
import NonfungiblePositionManagerAbi from './abi/NonfungiblePositionManager.json';
import NuraProfileAbi from './abi/NuraProfile.json';
import NuraProfileLensAbi from './abi/NuraProfileLens.json';
import PredictionFactoryAbi from './abi/PredictionFactory.json';
import PredictionMarketAbi from './abi/PredictionMarket.json';
import PredictionPoolAbi from './abi/PredictionPool.json';
import PredictionTreasuryAbi from './abi/PredictionTreasury.json';
import QuoterV2Abi from './abi/QuoterV2.json';
import SocialVerifierAbi from './abi/SocialVerifier.json';
import SwapRouterAbi from './abi/SwapRouter.json';
import UniswapV3FactoryAbi from './abi/UniswapV3Factory.json';
import WnuraAbi from './abi/WNURA.json';

import { NURA_CHAIN_ID } from './chain.ts';

export type ContractCategory =
    | 'token'
    | 'airdrop'
    | 'amm-v3'
    | 'prediction'
    | 'vault'
    | 'identity'
    | 'infra';

/**
 * The folder under contracts/ in the contracts repository that a contract is
 * built and deployed from. The contracts page is organised as one section per
 * folder, because that is how the repository itself is organised: each folder
 * is one Ignition module, deployed on its own with `hardhat deploy --sc <folder>`.
 * `testing` holds the wrapped-native coin; `external` is for canonical chain
 * infrastructure that no folder in the repository builds.
 */
export type ContractFolder =
    | 'token'
    | 'airdrop'
    | 'univ3'
    | 'vault'
    | 'forecast'
    | 'profile'
    | 'testing'
    | 'external';

export interface FolderDef
{
    id: ContractFolder;
    /** Path in the contracts repository, shown verbatim as the section's source. */
    path: string;
    title: string;
    description: string;
    /** How the folder is deployed, or where its contracts come from when this repository does not deploy them. */
    deploy: string;
}

export interface ContractDef
{
    /** URL slug and stable reference used by the activity log. */
    id: string;
    name: string;
    description: string;
    category: ContractCategory;
    /** Which contracts/<folder> the contract belongs to; decides its section on the contracts page. */
    folder: ContractFolder;
    chainId: number;
    /** Deployed address on record, or null when none has been recorded. */
    address: Address | null;
    abi: Abi;
    /** Where the deployment comes from, shown verbatim in the overview. */
    deploymentNote?: string;
    /**
     * Function names whose ABI says nonpayable but which are DESIGNED to be
     * called statically: they answer by reverting with their result in the
     * revert data (the Uniswap V3 Quoter pattern). Listed here so the UI can
     * offer them as reads instead of pretending they are transactions.
     */
    staticCallables?: string[];
}

export const CATEGORY_LABEL: Record<ContractCategory, string> = {
    token: 'Token',
    airdrop: 'Airdrop',
    'amm-v3': 'AMM · V3',
    prediction: 'Prediction',
    vault: 'Vault',
    identity: 'Identity',
    infra: 'Infrastructure'
};

/**
 * The sections of the contracts page, in display order: the contracts
 * repository's folders, in the order its README introduces them, then the two
 * groups that are not built there. Descriptions and deploy commands mirror the
 * repository's README and `hardhat deploy --sc` task.
 */
export const FOLDERS: readonly FolderDef[] = [
    {
        id: 'token',
        path: 'contracts/token',
        title: 'Bridge tokens',
        description: 'Bridged USDT and BNB representations: OpenZeppelin ERC20 with mint, burn, pause and permit behind AccessControl roles. Supply is minted by the bridge relayer against deposits on the source chain.',
        deploy: 'npx hardhat deploy --sc token --network nurachain'
    },
    {
        id: 'airdrop',
        path: 'contracts/airdrop',
        title: 'Airdrop',
        description: 'Native-coin claims gated by an EIP-712 signature from a backend signer. One claim per address, an immutable claim cap, funded separately after deployment.',
        deploy: 'npx hardhat deploy --sc airdrop --network nurachain (asks for the cap and reward)'
    },
    {
        id: 'univ3',
        path: 'contracts/univ3',
        title: 'Uniswap V3 exchange',
        description: 'Vendored Uniswap V3 core and periphery pinned to solc 0.7.6: the factory and its pools, the position manager, the router and the quoter.',
        deploy: 'npx hardhat deploy --sc univ3 --network nurachain'
    },
    {
        id: 'vault',
        path: 'contracts/vault',
        title: 'Collateralized NFT vault',
        description: 'An ERC721 where every token is a claim on a fixed amount of one backing ERC20 the contract holds. Minting reserves the collateral; redeeming burns the token and pays it out.',
        deploy: 'npx hardhat deploy --sc vault --network nurachain --parameters ./ignition/params.json, then scripts/vault-setup.ts'
    },
    {
        id: 'forecast',
        path: 'contracts/forecast',
        title: 'Forecast prediction markets',
        description: 'A factory that clones CPMM and parimutuel markets, resolves them through an N-of-M signer quorum, and forwards protocol fees to a treasury.',
        deploy: 'npx hardhat deploy --sc forecast --network nurachain'
    },
    {
        id: 'profile',
        path: 'contracts/profile',
        title: 'Nura Profile',
        description: 'The decentralized profile registry: one profile per address, unique usernames, localizable fields, websites, images, socials and any other item kind, operators, two-step transfer, and a curated extension registry - behind a UUPS proxy, with a stateless lens for reads and a reference verifier extension.',
        deploy: 'npx hardhat deploy --sc profile --network nurachain, then scripts/profile-setup.ts'
    },
    {
        id: 'testing',
        path: 'contracts/testing',
        title: 'Wrapped native coin',
        description: 'WNURA, the canonical WETH9-style wrapper for the native coin. It lives under contracts/testing because the live deployment predates this repository and is never redeployed.',
        deploy: 'Live since the original exchange deployment; not deployed by any module.'
    },
    {
        id: 'external',
        path: 'not in the contracts repository',
        title: 'Shared chain infrastructure',
        description: 'Canonical deployments every application on Nura Chain shares. Their ABIs are frozen snapshots; nothing in the contracts repository compiles or deploys them.',
        deploy: 'Deployed once, chain-wide.'
    }
];

export function findFolder(id: ContractFolder): FolderDef
{
    // Every ContractFolder has exactly one entry above; the fallback only guards a typo in this file.
    return FOLDERS.find((folder) => folder.id === id) ?? FOLDERS[FOLDERS.length - 1];
}

export function contractsInFolder(id: ContractFolder): ContractDef[]
{
    return CONTRACTS.filter((def) => def.folder === id);
}

// Live addresses on Nura Chain (1020), as recorded in the contracts repository
// (README, ignition module defaults, and the fork-patched position descriptor).
const BRIDGE_USDT = '0x4E0DB0B1Da408faF5637202CF48b0bc7733bE6dC' as Address;
const BRIDGE_BNB = '0xD4221Ad9772BF5bA7423a044bBBEe6af2154A5Fc' as Address;
const WNURA = '0xf0a4eC07916feBa4432121Ed5969887D9b939cD0' as Address;
const MULTICALL3 = '0xf58884FCf45d8F5Cc8A73c618D23EB27b732CA24' as Address;
// Forecast (prediction market) – deployed 2026-08-26 via ignition/modules/forecast.ts
// Batch #1: implementations + treasury, Batch #2: factory (clone deployer + registry).
// See ignition/deployments/chain-1020/journal.jsonl and hardhat.config.ts:619 ignition fees.
const PREDICTION_MARKET_IMPL = '0x4b94c8F32Ff506D31d79d21D94eC1d8AE3d1F145' as Address;
const PREDICTION_POOL_IMPL = '0x675b24758B199c3A5674f0288dfdeaA217fB2A86' as Address;
const PREDICTION_TREASURY = '0xDABEDD148F5AE5f3e130aB811a8975828Ea75AA8' as Address;
const PREDICTION_FACTORY = '0x33fE315c8a7FeA10152dD2b21B5d87936aF9B79d' as Address;
// Profile registry – deployed 2026-09-05 via ignition/modules/profile.ts
// (`npm run deploy:nurachain:profile`). The PROXY is the registry address every
// caller uses; the implementation behind it (NuraProfile 1.0.0, currently
// 0x8ff69542387343fe8a9e053779f23058fBbA7f71) changes on every UUPS upgrade and
// matters only for source verification. Checked against the chain: the proxy's
// ERC-1967 slot points at that implementation, lens.core() and
// verifier.profileRegistry() both return the proxy.
const NURA_PROFILE_PROXY = '0x8CFbcEf737BE3C67A52A20Ae3DCC685ACF759460' as Address;
const NURA_PROFILE_LENS = '0xE8BD8Fc19907274b3CF87Bd72F4cd92Ca3c62F05' as Address;
const SOCIAL_VERIFIER = '0xc81bF5e81a9aB9447eeE873b916538750f3161D8' as Address;

export const CONTRACTS: readonly ContractDef[] = [
    {
        id: 'bridge-usdt',
        name: 'BridgeUSDT',
        description: 'Bridge-managed USDT representation. OpenZeppelin ERC20 with mint/burn, pause and permit behind AccessControl roles.',
        category: 'token',
        folder: 'token',
        chainId: NURA_CHAIN_ID,
        address: BRIDGE_USDT,
        abi: BridgeUsdtAbi as Abi,
        deploymentNote: 'Deployed by ignition/modules/token.ts.'
    },
    {
        id: 'bridge-bnb',
        name: 'BridgeBNB',
        description: 'Bridge-managed BNB representation. OpenZeppelin ERC20 with mint/burn, pause and permit behind AccessControl roles.',
        category: 'token',
        folder: 'token',
        chainId: NURA_CHAIN_ID,
        address: BRIDGE_BNB,
        abi: BridgeBnbAbi as Abi,
        deploymentNote: 'Deployed by ignition/modules/token.ts.'
    },
    {
        id: 'wnura',
        name: 'WNURA',
        description: 'Wrapped NURA. The canonical WETH9 wrapper: deposit native coin to mint, withdraw to unwrap.',
        category: 'token',
        folder: 'testing',
        chainId: NURA_CHAIN_ID,
        address: WNURA,
        abi: WnuraAbi as Abi,
        deploymentNote: 'Live since the original exchange deployment.'
    },
    {
        id: 'multicall3',
        name: 'Multicall3',
        description: 'Aggregate arbitrary calls into one transaction or one eth_call. Shared infrastructure across the chain.',
        category: 'infra',
        folder: 'external',
        chainId: NURA_CHAIN_ID,
        address: MULTICALL3,
        abi: Multicall3Abi as Abi,
        deploymentNote: 'Shared Multicall3 deployment.'
    },
    {
        id: 'airdrop',
        name: 'Airdrop',
        description: 'Native-coin claims gated by an EIP-712 signature from a backend signer. Funded separately; immutable claim cap.',
        category: 'airdrop',
        folder: 'airdrop',
        chainId: NURA_CHAIN_ID,
        address: null,
        abi: AirdropAbi as Abi,
        deploymentNote: 'Deployed by ignition/modules/airdrop.ts with --max-claims/--reward; address recorded at deploy time only.'
    },
    {
        id: 'prediction-factory',
        name: 'PredictionFactory',
        description: 'Deploys prediction-market clones (CPMM and parimutuel) and keeps the registry. Admin controls fees, treasury and lifecycle; resolution itself needs an N-of-M signer quorum (e.g. 3-of-5).',
        category: 'prediction',
        folder: 'forecast',
        chainId: NURA_CHAIN_ID,
        address: PREDICTION_FACTORY,
        abi: PredictionFactoryAbi as Abi,
        deploymentNote: 'Deployed 2026-08-26 by ignition/modules/forecast.ts (`npm run deploy:nurachain:forecast`) — Batch #2. Verified on Nurachain (1020) at 0x33fE315c8a7FeA10152dD2b21B5d87936aF9B79d.'
    },
    {
        id: 'prediction-market',
        name: 'PredictionMarket',
        description: 'CPMM prediction market clone implementation (ERC1155 outcome shares): buy, sell, merge sets, redeem, funding controls. This is the template; each live market is a minimal proxy via PredictionFactory.createMarket.',
        category: 'prediction',
        folder: 'forecast',
        chainId: NURA_CHAIN_ID,
        address: PREDICTION_MARKET_IMPL,
        abi: PredictionMarketAbi as Abi,
        deploymentNote: 'Implementation deployed 2026-08-26 by forecast Batch #1 at 0x4b94c8F32Ff506D31d79d21D94eC1d8AE3d1F145 (clones via factory; paste a specific market address to interact as an instance).'
    },
    {
        id: 'prediction-pool',
        name: 'PredictionPool',
        description: 'Parimutuel prediction market clone implementation: bet native coin on an outcome, admin resolves after lockTime, winners claim pro-rata net of fee. This is the template; each live market is a minimal proxy via PredictionFactory.createMarket2.',
        category: 'prediction',
        folder: 'forecast',
        chainId: NURA_CHAIN_ID,
        address: PREDICTION_POOL_IMPL,
        abi: PredictionPoolAbi as Abi,
        deploymentNote: 'Implementation deployed 2026-08-26 by forecast Batch #1 at 0x675b24758B199c3A5674f0288dfdeaA217fB2A86 (clones via factory; paste a specific market address to interact as an instance).'
    },
    {
        id: 'prediction-treasury',
        name: 'PredictionTreasury',
        description: 'Collects protocol fees from markets; withdraws go to the configured fee recipient.',
        category: 'prediction',
        folder: 'forecast',
        chainId: NURA_CHAIN_ID,
        address: PREDICTION_TREASURY,
        abi: PredictionTreasuryAbi as Abi,
        deploymentNote: 'Deployed 2026-08-26 by forecast Batch #1 at 0xDABEDD148F5AE5f3e130aB811a8975828Ea75AA8; repointable via PredictionFactory.setTreasury.'
    },
    {
        id: 'collateralized-nft',
        name: 'CollateralizedNFT',
        description: 'ERC721 where every token locks a fixed slice of one backing ERC20 reserve. Mint gated until public mint is enabled.',
        category: 'vault',
        folder: 'vault',
        chainId: NURA_CHAIN_ID,
        address: null,
        abi: CollateralizedNftAbi as Abi,
        deploymentNote: 'Deployed by ignition/modules/vault.ts plus scripts/vault-setup.ts.'
    },
    {
        id: 'nura-profile',
        name: 'NuraProfile',
        description: 'Decentralized profile registry: one profile per address, unique usernames, localizable fields, generic websites/images/socials (and any other item kind), operators, two-step transfer, curated extensions. UUPS proxy - this is the implementation ABI at the proxy address.',
        category: 'identity',
        folder: 'profile',
        chainId: NURA_CHAIN_ID,
        address: NURA_PROFILE_PROXY,
        abi: NuraProfileAbi as Abi,
        deploymentNote: 'Deployed 2026-09-05 by ignition/modules/profile.ts (`npm run deploy:nurachain:profile`). This is the NuraProfileProxy; the implementation behind it is NuraProfile 1.0.0 at 0x8ff69542387343fe8a9e053779f23058fBbA7f71. Extensions are registered by the owner via scripts/profile-setup.ts.'
    },
    {
        id: 'nura-profile-lens',
        name: 'NuraProfileLens',
        description: 'Read model over NuraProfile: getProfile(address, lang), getFullProfile, getWebsites/getImages/getSocials and paged getItems, all resolved in one language with fallback. Stateless and replaceable.',
        category: 'identity',
        folder: 'profile',
        chainId: NURA_CHAIN_ID,
        address: NURA_PROFILE_LENS,
        abi: NuraProfileLensAbi as Abi,
        deploymentNote: 'Deployed 2026-09-05 alongside the core by ignition/modules/profile.ts; core() is the NuraProfileProxy at 0x8CFbcEf737BE3C67A52A20Ae3DCC685ACF759460.'
    },
    {
        id: 'social-verifier',
        name: 'SocialVerifier',
        description: 'Reference profile extension: records EIP-712-attested handles (GitHub, X, Telegram, ...) into its own namespace on a profile after the owner opts in. VERIFIER_ROLE signs, owner or operator submits.',
        category: 'identity',
        folder: 'profile',
        chainId: NURA_CHAIN_ID,
        address: SOCIAL_VERIFIER,
        abi: SocialVerifierAbi as Abi,
        deploymentNote: 'Deployed 2026-09-05 by ignition/modules/profile.ts; profileRegistry() is the NuraProfileProxy. Becomes active once the core owner registers it as "social-verifier" (scripts/profile-setup.ts) and a profile owner approves it.'
    },
    {
        id: 'uniswap-v3-factory',
        name: 'UniswapV3Factory',
        description: 'Creates V3 pools per fee tier and owns them. Pools themselves are created deterministically, one address each.',
        category: 'amm-v3',
        folder: 'univ3',
        chainId: NURA_CHAIN_ID,
        address: null,
        abi: UniswapV3FactoryAbi as Abi,
        deploymentNote: 'Deployed by ignition/modules/univ3.ts; address recorded at deploy time only.'
    },
    {
        id: 'nonfungible-position-manager',
        name: 'NonfungiblePositionManager',
        description: 'Mints liquidity positions as NFTs: mint, increase, decrease, collect fees, burn.',
        category: 'amm-v3',
        folder: 'univ3',
        chainId: NURA_CHAIN_ID,
        address: null,
        abi: NonfungiblePositionManagerAbi as Abi,
        deploymentNote: 'Deployed alongside the V3 core by ignition/modules/univ3.ts.'
    },
    {
        id: 'swap-router',
        name: 'SwapRouter',
        description: 'V3 swaps: exactInput/exactOutput single- and multi-pool routes, with multicall and native-coin refund helpers.',
        category: 'amm-v3',
        folder: 'univ3',
        chainId: NURA_CHAIN_ID,
        address: null,
        abi: SwapRouterAbi as Abi,
        deploymentNote: 'Deployed alongside the V3 core by ignition/modules/univ3.ts.'
    },
    {
        id: 'quoter-v2',
        name: 'QuoterV2',
        description: 'Quotes V3 swap results. Answers by REVERTING with the quote encoded in the revert data - callable statically, never sendable.',
        category: 'amm-v3',
        folder: 'univ3',
        chainId: NURA_CHAIN_ID,
        address: null,
        abi: QuoterV2Abi as Abi,
        staticCallables: ['quoteExactInput', 'quoteExactInputSingle', 'quoteExactOutput', 'quoteExactOutputSingle'],
        deploymentNote: 'Deployed alongside the V3 core by ignition/modules/univ3.ts.'
    }
];

export function findContract(id: string | undefined): ContractDef | undefined
{
    return CONTRACTS.find((def) => def.id === id);
}

export function isKnownCategory(value: string): value is ContractCategory
{
    return Object.hasOwn(CATEGORY_LABEL, value);
}
