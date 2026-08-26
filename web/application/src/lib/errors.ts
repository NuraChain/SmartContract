// Every blockchain failure this app can surface, translated ONCE. Pure
// classification - no chain, no wallet, no DOM - so tests can pin the exact
// wording users see. EIP-1193 providers reject with PLAIN OBJECTS
// ({ code: 4001, message }), not Errors; stringifying one yields
// "[object Object]", so the shape walk matters.

export type FailureCode =
    | 'wallet-not-connected'
    | 'user-rejected'
    | 'request-pending'
    | 'wrong-network'
    | 'insufficient-funds'
    | 'contract-reverted'
    | 'invalid-arguments'
    | 'rpc-error'
    | 'unknown';

export interface ClassifiedError
{
    code: FailureCode;
    /** The sentence shown as the primary message. */
    title: string;
    /** One line of guidance under the title. */
    hint: string;
    /** Raw technical text for the expandable debugging detail. */
    technical: string;
}

export const FAILURE_TITLE: Record<FailureCode, string> = {
    'wallet-not-connected': 'Wallet not connected',
    'user-rejected': 'Request rejected',
    'request-pending': 'Request already pending',
    'wrong-network': 'Wrong network',
    'insufficient-funds': 'Insufficient funds',
    'contract-reverted': 'Transaction reverted',
    'invalid-arguments': 'Invalid input',
    'rpc-error': 'Network request failed',
    unknown: 'Something went wrong'
};

export const FAILURE_HINT: Record<FailureCode, string> = {
    'wallet-not-connected': 'Connect a wallet to call this function.',
    'user-rejected': 'The request was declined in your wallet. Nothing was sent.',
    'request-pending': 'Your wallet still has an earlier request open. Approve or reject it there first.',
    'wrong-network': 'Switch your wallet to Nura Chain (chain id 1020) and try again.',
    'insufficient-funds': 'The connected account does not hold enough NURA for this amount plus gas.',
    'contract-reverted': 'The contract rejected the call on-chain. Check the parameters and any requirements.',
    'invalid-arguments': 'Check the highlighted fields and try again.',
    'rpc-error': 'The RPC endpoint did not answer. It may be down or rate-limited; retry shortly.',
    unknown: 'No specific cause was reported. Expand the details below for the raw error.'
};

function textOf(error: unknown): string
{
    if (error instanceof Error)
    {
        return `${ error.message } ${ String((error as { cause?: unknown }).cause ?? '') }`;
    }
    if (typeof error === 'object' && error !== null)
    {
        const shape = error as { code?: unknown; message?: unknown; reason?: unknown; shortMessage?: unknown };
        return [shape.code, shape.shortMessage ?? shape.message, shape.reason]
            .filter((part) => part !== undefined)
            .join(' ');
    }
    return String(error);
}

/** Decodes Solidity revert data: `Error(string)` and `Panic(uint256)`. */
export function decodeRevertData(data: string): string | null
{
    if (!/^0x[0-9a-fA-F]*$/.test(data))
    {
        return null;
    }
    // keccak256("Error(string)")[0:4] = 0x08c379a0: selector + offset(32B) +
    // length(32B) + UTF-8 bytes. keccak256("Panic(uint256)")[0:4] = 0x4e487b71.
    if (data.startsWith('0x08c379a0'))
    {
        try
        {
            const length = Number.parseInt(data.slice(74, 138), 16);
            const hex = data.slice(138, 138 + length * 2);
            let text = '';
            for (let index = 0; index < hex.length; index += 2)
            {
                text += String.fromCharCode(Number.parseInt(hex.slice(index, index + 2), 16));
            }
            return text;
        }
        catch
        {
            return null;
        }
    }
    if (data.startsWith('0x4e487b71'))
    {
        try
        {
            const panic = BigInt(`0x${ data.slice(10, 74) }`);
            const causes: Record<string, string> = {
                '1': 'assertion failed',
                '17': 'arithmetic overflow/underflow',
                '18': 'division by zero',
                '33': 'invalid enum value',
                '34': 'malformed storage byte array'
            };
            return `Panic (${ causes[panic.toString()] ?? `code ${ panic }` })`;
        }
        catch
        {
            return null;
        }
    }
    if (data.length >= 10)
    {
        return `custom error ${ data.slice(0, 10) }`;
    }
    return null;
}

export function classifyError(error: unknown): ClassifiedError
{
    const message = textOf(error);
    const build = (code: FailureCode, extra = ''): ClassifiedError =>
        ({
            code,
            title: FAILURE_TITLE[code],
            hint: FAILURE_HINT[code],
            technical: `${ message }${ extra === '' ? '' : ` ${ extra }` }`.trim()
        });

    if (/user rejected|user denied|ACTION_REJECTED|\b4001\b/i.test(message))
    {
        return build('user-rejected');
    }
    if (message.includes('-32002'))
    {
        return build('request-pending');
    }
    if (/ChainMismatch|does not match the target chain|chain of the wallet/i.test(message))
    {
        return build('wrong-network');
    }
    if (/wallet not connected|account is not set/i.test(message))
    {
        return build('wallet-not-connected');
    }
    if (/insufficient funds|exceeds.*balance|insufficient balance|INSUFFICIENT_BALANCE/i.test(message))
    {
        return build('insufficient-funds');
    }
    // Raw revert data first - a decodable blob beats a vague "reverted".
    const dataMatch = /(?:data|reason)\s*"?(0x[0-9a-fA-F]{8,})"?/i.exec(message);
    if (dataMatch !== null)
    {
        const decoded = decodeRevertData(dataMatch[1]);
        if (decoded !== null)
        {
            return {
                code: 'contract-reverted',
                title: `Reverted: ${ decoded }`,
                hint: FAILURE_HINT['contract-reverted'],
                technical: message
            };
        }
    }
    // viem surfaces reverts with the decoded reason attached.
    const revertMatch =
        /execution reverted(?: with reason "?([^"]*)"?)?/i.exec(message) ??
        /revert:? ([^"]+)$/i.exec(message);
    if (revertMatch !== null)
    {
        const reason = revertMatch[1];
        return {
            code: 'contract-reverted',
            title: reason !== undefined && reason.trim() !== '' ? `Reverted: ${ reason.trim() }` : FAILURE_TITLE['contract-reverted'],
            hint: FAILURE_HINT['contract-reverted'],
            technical: message
        };
    }
    if (/execution reverted|revert/i.test(message))
    {
        return build('contract-reverted');
    }
    if (
        /InvalidInputError|invalid address|cannot parse|missing|expected/i.test(message) ||
        error instanceof Error && error.name === 'InvalidInputError'
    )
    {
        return build('invalid-arguments');
    }
    if (/-32\d{3}|rate limit|too many requests|network error|fetch failed|timeout|ETIMEDOUT|ENOTFOUND|503|429/i.test(message))
    {
        return build('rpc-error');
    }
    return build('unknown');
}
