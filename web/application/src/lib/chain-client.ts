// Read-side chain access: one public client over the configured RPC, plus the
// on-chain existence probe the overview and cards use. Writes never come
// through here - they go through lib/tx-manager.ts with the wallet client.

import { createPublicClient, http } from 'viem';
import type { Address, PublicClient } from 'viem';

import { NURA_CHAIN } from '../config/chain.ts';

let cached: PublicClient | null = null;

export function publicClient(): PublicClient
{
    cached ??= createPublicClient({
        chain: NURA_CHAIN,
        transport: http(NURA_CHAIN.rpcUrls.default.http[0])
    });
    return cached;
}

/**
 * Whether bytecode lives at `address`, or null when the RPC could not answer.
 * An entry-point-less address is reported honestly - never assumed deployed.
 */
export async function codeAt(address: Address): Promise<boolean | null>
{
    try
    {
        const code = await publicClient().getCode({ address });
        return code !== undefined && code !== '0x';
    }
    catch
    {
        return null;
    }
}
