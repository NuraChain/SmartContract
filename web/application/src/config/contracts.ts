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
import PredictionFactoryAbi from './abi/PredictionFactory.json';
import PredictionMarketAbi from './abi/PredictionMarket.json';
import PredictionPoolAbi from './abi/PredictionPool.json';
import PredictionTreasuryAbi from './abi/PredictionTreasury.json';
import QuoterV2Abi from './abi/QuoterV2.json';
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
    | 'infra';

export interface ContractDef
{
    /** URL slug and stable reference used by the activity log. */
    id: string;
    name: string;
    description: string;
    category: ContractCategory;
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
    infra: 'Infrastructure'
};

// Live addresses on Nura Chain (1020), as recorded in the contracts repository
// (README, ignition module defaults, and the fork-patched position descriptor).
const BRIDGE_USDT = '0x4E0DB0B1Da408faF5637202CF48b0bc7733bE6dC' as Address;
const BRIDGE_BNB = '0xD4221Ad9772BF5bA7423a044bBBEe6af2154A5Fc' as Address;
const WNURA = '0xf0a4eC07916feBa4432121Ed5969887D9b939cD0' as Address;
const MULTICALL3 = '0xf58884FCf45d8F5Cc8A73c618D23EB27b732CA24' as Address;

export const CONTRACTS: readonly ContractDef[] = [
    {
        id: 'bridge-usdt',
        name: 'BridgeUSDT',
        description: 'Bridge-managed USDT representation. OpenZeppelin ERC20 with mint/burn, pause and permit behind AccessControl roles.',
        category: 'token',
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
        chainId: NURA_CHAIN_ID,
        address: null,
        abi: AirdropAbi as Abi,
        deploymentNote: 'Deployed by ignition/modules/airdrop.ts with --max-claims/--reward; address recorded at deploy time only.'
    },
    {
        id: 'prediction-factory',
        name: 'PredictionFactory',
        description: 'Deploys prediction-market clones (CPMM and parimutuel) and keeps the registry. Admin controls fees, treasury and market lifecycle.',
        category: 'prediction',
        chainId: NURA_CHAIN_ID,
        address: null,
        abi: PredictionFactoryAbi as Abi,
        deploymentNote: 'Deployed by ignition/modules/forecast.ts (`npm run deploy:nurachain:forecast`); address recorded at deploy time only.'
    },
    {
        id: 'prediction-market',
        name: 'PredictionMarket',
        description: 'One CPMM prediction market instance (ERC1155 outcome shares): buy, sell, merge sets, redeem, funding controls.',
        category: 'prediction',
        chainId: NURA_CHAIN_ID,
        // Clones are created by the factory; there is no single fixed address.
        address: null,
        abi: PredictionMarketAbi as Abi,
        deploymentNote: 'Instances are deployed by PredictionFactory.createMarket; paste a specific market via the factory listing first.'
    },
    {
        id: 'prediction-pool',
        name: 'PredictionPool',
        description: 'One parimutuel prediction market instance: bet native coin on an outcome, admin resolves after lockTime, winners claim pro-rata net of fee.',
        category: 'prediction',
        chainId: NURA_CHAIN_ID,
        // Clones are created by the factory; there is no single fixed address.
        address: null,
        abi: PredictionPoolAbi as Abi,
        deploymentNote: 'Instances are deployed by PredictionFactory.createMarket2; paste a specific market via the factory listing first.'
    },
    {
        id: 'prediction-treasury',
        name: 'PredictionTreasury',
        description: 'Collects protocol fees from markets; withdraws go to the configured fee recipient.',
        category: 'prediction',
        chainId: NURA_CHAIN_ID,
        address: null,
        abi: PredictionTreasuryAbi as Abi,
        deploymentNote: 'Repointed per-deployment via PredictionFactory.setTreasury.'
    },
    {
        id: 'collateralized-nft',
        name: 'CollateralizedNFT',
        description: 'ERC721 where every token locks a fixed slice of one backing ERC20 reserve. Mint gated until public mint is enabled.',
        category: 'vault',
        chainId: NURA_CHAIN_ID,
        address: null,
        abi: CollateralizedNftAbi as Abi,
        deploymentNote: 'Deployed by ignition/modules/vault.ts plus scripts/vault-setup.ts.'
    },
    {
        id: 'uniswap-v3-factory',
        name: 'UniswapV3Factory',
        description: 'Creates V3 pools per fee tier and owns them. Pools themselves are created deterministically, one address each.',
        category: 'amm-v3',
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
