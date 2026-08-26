// The one definition of the network every contract in the registry targets.
// Values mirror the nurachain entry in the contracts repository's
// hardhat.config.ts; nothing here is discovered at runtime.

import { defineChain } from 'viem';

export const NURA_CHAIN_ID = 1020;
export const NURA_CURRENCY = { name: 'NURA', symbol: 'NURA', decimals: 18 } as const;

export const NURA_CHAIN = defineChain({
    id: NURA_CHAIN_ID,
    name: 'Nura Chain',
    nativeCurrency: { ...NURA_CURRENCY },
    rpcUrls: { default: { http: ['https://rpc.nurachain.net'] } },
    blockExplorers: {
        default: { name: 'Nura Explorer', url: 'https://explorer.nurachain.net' }
    }
});

/** EIP-3085 parameters for registering the chain in a wallet. Absent, NOT empty,
 *  blockExplorerUrls when there is no explorer - wallets reject an empty array. */
export function addChainParams(): object
{
    return {
        chainId: `0x${ NURA_CHAIN_ID.toString(16) }`,
        chainName: NURA_CHAIN.name,
        nativeCurrency: { ...NURA_CURRENCY },
        rpcUrls: NURA_CHAIN.rpcUrls.default.http,
        blockExplorerUrls: [NURA_CHAIN.blockExplorers.default.url]
    };
}

export function explorerTxUrl(hash: string): string
{
    return `${ NURA_CHAIN.blockExplorers.default.url }/tx/${ hash }`;
}

export function explorerAddressUrl(address: string): string
{
    return `${ NURA_CHAIN.blockExplorers.default.url }/address/${ address }`;
}
