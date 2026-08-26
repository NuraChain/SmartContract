// Regression: disconnect used to clear local state only, leaving the wallet's
// eth_accounts permission alive - the next connect silently resumed the SAME
// account and there was no way to switch wallets. Disconnect must revoke the
// permission so the next eth_requestAccounts prompts again.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/chain-client.ts', () => ({
    publicClient: (): { getBalance: () => Promise<bigint> } => ({ getBalance: async () => 0n }),
    codeAt: async (): Promise<boolean | null> => null
}));

import { account, connectInjected, disconnect } from '../src/lib/wallet/store.ts';
import type { Eip1193Provider, WalletOption } from '../src/lib/wallet/store.ts';

const ADDRESS_A = '0x1111111111111111111111111111111111111111';
const ADDRESS_B = '0x2222222222222222222222222222222222222222';

interface RecordedCall
{
    method: string;
    params?: unknown;
}

function fakeProvider(initialAccounts: string[]): {
    option: WalletOption;
    requests: RecordedCall[];
    grant: (accounts: string[]) => void;
    emit: (event: string, payload: unknown) => void;
}
{
    let granted = initialAccounts;
    const requests: RecordedCall[] = [];
    const listeners = new Map<string, Array<(payload: unknown) => void>>();
    const provider: Eip1193Provider = {
        request: async (args: { method: string; params?: unknown[] | object }) =>
        {
            requests.push({ method: args.method, params: args.params });
            if (args.method === 'eth_requestAccounts' || args.method === 'eth_accounts')
            {
                return [...granted];
            }
            if (args.method === 'eth_chainId')
            {
                // Nura Chain, 1020.
                return '0x3fc';
            }
            return null;
        },
        on: (event: string, handler: (payload: never) => void) =>
        {
            const list = listeners.get(event) ?? [];
            list.push(handler as (payload: unknown) => void);
            listeners.set(event, list);
        },
        removeListener: () =>
        {
        }
    };
    return {
        option: { id: 'test.wallet', name: 'Test Wallet', icon: null, provider },
        requests,
        grant: (accounts: string[]) =>
        {
            granted = accounts;
        },
        emit: (event: string, payload: unknown) =>
        {
            for (const handler of listeners.get(event) ?? [])
            {
                handler(payload);
            }
        }
    };
}

describe('wallet store disconnect', () =>
{
    beforeEach(() =>
    {
        disconnect();
    });

    it('clears the local session', async () =>
    {
        const harness = fakeProvider([ADDRESS_A]);
        expect(await connectInjected(harness.option)).toBe(true);
        expect(account()).toBe(ADDRESS_A);

        disconnect();

        expect(account()).toBeNull();
    });

    it('revokes eth_accounts so the next connect re-prompts', async () =>
    {
        const harness = fakeProvider([ADDRESS_A]);
        await connectInjected(harness.option);

        disconnect();

        expect(harness.requests.some((call) => call.method === 'wallet_revokePermissions')).toBe(true);
        const revoke = harness.requests.find((call) => call.method === 'wallet_revokePermissions');
        expect(revoke?.params).toEqual([{ eth_accounts: {} }]);
    });

    it('lets a different account connect after a disconnect cycle', async () =>
    {
        const harness = fakeProvider([ADDRESS_A]);
        expect(await connectInjected(harness.option)).toBe(true);
        expect(account()).toBe(ADDRESS_A);

        disconnect();

        // The user picked another account in the wallet's re-prompted dialog.
        harness.grant([ADDRESS_B]);
        expect(await connectInjected(harness.option)).toBe(true);
        expect(account()).toBe(ADDRESS_B);

        const firstRevoke = harness.requests.findIndex((call) => call.method === 'wallet_revokePermissions');
        const resume = harness.requests
            .map((call, index) => ({ call, index }))
            .filter(({ call }) => call.method === 'eth_requestAccounts')[1];
        expect(firstRevoke).toBeGreaterThanOrEqual(0);
        expect(firstRevoke).toBeLessThan(resume.index);

        disconnect();
    });

    it('adopts the switched account when the wallet emits accountsChanged', async () =>
    {
        const harness = fakeProvider([ADDRESS_A]);
        await connectInjected(harness.option);
        expect(account()).toBe(ADDRESS_A);

        // The user picked another account inside the wallet; the provider
        // notifies with the new permitted list.
        harness.grant([ADDRESS_B]);
        harness.emit('accountsChanged', [ADDRESS_B]);

        expect(account()).toBe(ADDRESS_B);

        disconnect();
    });

    it('disconnects when accountsChanged reports no accounts', async () =>
    {
        const harness = fakeProvider([ADDRESS_A]);
        await connectInjected(harness.option);
        expect(account()).toBe(ADDRESS_A);

        harness.emit('accountsChanged', []);

        expect(account()).toBeNull();

        disconnect();
    });

    it('re-syncs a missed account switch on the next poll tick', async () =>
    {
        vi.useFakeTimers();
        try
        {
            const harness = fakeProvider([ADDRESS_A]);
            await connectInjected(harness.option);
            expect(account()).toBe(ADDRESS_A);

            // An event that never arrived (locked extension, missed delivery):
            // the wallet's permitted account moved on behind our back.
            harness.grant([ADDRESS_B]);

            await vi.advanceTimersByTimeAsync(5000);

            expect(account()).toBe(ADDRESS_B);

            disconnect();
        }
        finally
        {
            vi.useRealTimers();
        }
    });
});
