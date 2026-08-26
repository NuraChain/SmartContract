// The write path. Every state-changing call goes through here and nowhere
// else: prepare (validate + gas estimate + revert decode), then submit
// (sign -> hash -> receipt), with the activity log updated at each edge.
// The UI orchestrates phases; this module owns the chain work.

import { encodeFunctionData } from 'viem';
import type { Abi, Address } from 'viem';

import { NURA_CHAIN, explorerTxUrl } from '../config/chain.ts';
import { dropActivity, recordActivity, updateActivity } from './history.ts';
import { classifyError } from './errors.ts';
import { publicClient } from './chain-client.ts';
import {
    bumpTxEpoch,
    isConnected,
    onRightChain,
    refreshBalance,
    requiredWallet,
    toastPending,
    toastResolve
} from './wallet/store.ts';

export interface WriteRequest
{
    contractId: string;
    contractName: string;
    address: Address;
    abi: Abi;
    functionName: string;
    signature: string;
    args: readonly unknown[];
    /** Native value attached, in wei. */
    value: bigint;
}

export interface PreparedWrite
{
    gasEstimate: bigint | null;
    calldata: string;
}

export interface SubmitOutcome
{
    status: 'confirmed' | 'reverted';
    hash: Address | null;
    blockNumber: number | null;
    gasUsed: bigint | null;
}

/** Phases the review modal renders while a submission is in flight. */
export type SubmitPhase = 'signing' | 'pending' | 'settled';

/**
 * Guards + gas estimate for one write. Throws ClassifiedError on any refusal:
 * not connected, wrong network, or an estimation that reverted on-chain.
 */
export async function prepareWrite(request: WriteRequest): Promise<PreparedWrite>
{
    if (!isConnected())
    {
        throw classifyError(new Error('wallet not connected'));
    }
    if (!onRightChain())
    {
        throw classifyError({ code: -32000, message: 'ChainMismatch: the wallet is on a different chain than the target' });
    }
    const calldata = encodeFunctionData({
        abi: request.abi,
        functionName: request.functionName,
        args: request.args as never
    });
    try
    {
        const gasEstimate = await publicClient().estimateContractGas({
            address: request.address,
            abi: request.abi,
            functionName: request.functionName,
            args: request.args as never,
            account: requiredWallet().account,
            value: request.value > 0n ? request.value : undefined
        });
        return { gasEstimate, calldata };
    }
    catch (error)
    {
        throw classifyError(error);
    }
}

export interface SubmitHooks
{
    onPhase(phase: SubmitPhase): void;
    onHash(hash: Address): void;
}

/**
 * Sends the prepared write through the connected wallet and tracks it to a
 * receipt. Resolves with the outcome; throws ClassifiedError only for
 * failures BEFORE a hash exists (rejections) - everything after is reported
 * through the activity log and the resolved result.
 */
export async function submitWrite(request: WriteRequest, hooks: SubmitHooks): Promise<SubmitOutcome>
{
    let hash: Address;
    const activityId = recordActivity({
        hash: null,
        contractId: request.contractId,
        contractName: request.contractName,
        functionName: request.functionName,
        signature: request.signature,
        paramsText: paramsSummary(request),
        value: request.value,
        status: 'pending',
        timestamp: Date.now(),
        blockNumber: null,
        gasUsed: null,
        chainId: 1020
    });
    const toastId = toastPending(`Sending ${ request.signature }…`);
    try
    {
        hooks.onPhase('signing');
        const wallet = requiredWallet();
        if (wallet.account === undefined)
        {
            throw classifyError(new Error('wallet not connected'));
        }
        hash = await wallet.writeContract({
            address: request.address,
            abi: request.abi,
            functionName: request.functionName,
            args: request.args as never,
            chain: NURA_CHAIN,
            account: wallet.account,
            ...(request.value > 0n ? { value: request.value } : {})
        });
    }
    catch (error)
    {
        // No hash, no transaction: a rejection leaves no trace in the log.
        dropActivity(activityId);
        throw classifyError(error);
    }

    hooks.onHash(hash);
    updateActivity(activityId, { hash });
    hooks.onPhase('pending');
    try
    {
        const receipt = await publicClient().waitForTransactionReceipt({ hash });
        const ok = receipt.status === 'success';
        updateActivity(activityId, {
            status: ok ? 'confirmed' : 'reverted',
            blockNumber: Number(receipt.blockNumber),
            gasUsed: receipt.gasUsed ?? null
        });
        const url = explorerTxUrl(hash);
        toastResolve(
            toastId,
            ok ? 'success' : 'error',
            ok ? `${ request.signature } confirmed` : `${ request.signature } reverted`,
            url === undefined ? undefined : { href: url, label: 'View on explorer' }
        );
        void refreshBalance();
        bumpTxEpoch();
        return {
            status: ok ? 'confirmed' : 'reverted',
            hash,
            blockNumber: Number(receipt.blockNumber),
            gasUsed: receipt.gasUsed ?? null
        };
    }
    catch (error)
    {
        // The transaction EXISTS but its fate is unknown (RPC died waiting).
        // Keep it pending in the log; say so honestly.
        toastResolve(toastId, 'error', `Lost track of ${ request.signature } - check the explorer`, {
            href: explorerTxUrl(hash),
            label: 'View on explorer'
        });
        throw classifyError(error);
    }
}

function paramsSummary(request: WriteRequest): string
{
    const parts = request.args.map((arg) => formatArg(arg));
    return request.value > 0n
        ? `${ parts.join(', ') } · value ${ request.value.toString() } wei`
        : parts.join(', ');
}

function formatArg(arg: unknown): string
{
    if (typeof arg === 'bigint')
    {
        return arg.toString();
    }
    if (Array.isArray(arg))
    {
        return `[${ arg.map(formatArg).join(', ') }]`;
    }
    if (typeof arg === 'object' && arg !== null)
    {
        return `{ ${ Object.entries(arg).map(([key, value]) => `${ key }: ${ formatArg(value) }`).join(', ') } }`;
    }
    if (arg === undefined || arg === null)
    {
        return '';
    }
    return String(arg);
}
