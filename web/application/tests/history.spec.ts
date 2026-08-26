import { afterEach, describe, expect, it } from 'vitest';

import { activity, clearActivity, dropActivity, recordActivity, updateActivity } from '../src/lib/history.ts';

function resetStorage(): void
{
    window.localStorage.clear();
    // The module caches its loaded flag; a fresh import per test would be
    // cleaner, but resetting through the public API is enough here.
    clearActivity();
}

afterEach(resetStorage);

describe('activity log', () =>
{
    it('records, updates and lists newest-first', () =>
    {
        const first = recordActivity(sample('transfer', 'pending', 1_000));
        recordActivity(sample('mint', 'pending', 2_000));

        updateActivity(first, { status: 'confirmed', blockNumber: 42 });

        const entries = activity();
        expect(entries).toHaveLength(2);
        expect(entries[0].functionName).toBe('mint');
        expect(entries[1].status).toBe('confirmed');
        expect(entries[1].blockNumber).toBe(42);
    });

    it('drops never-submitted entries (rejections)', () =>
    {
        const id = recordActivity(sample('approve', 'pending', 3_000));
        dropActivity(id);
        expect(activity()).toHaveLength(0);
    });

    it('persists bigints across storage round-trips', () =>
    {
        recordActivity({
            ...sample('deposit', 'confirmed', 4_000),
            value: 1_500_000_000_000_000_000n,
            gasUsed: 21_000n
        });

        // Force a reload from storage by clearing through the raw key.
        window.localStorage.setItem(
            'cm.activity.v1',
            window.localStorage.getItem('cm.activity.v1') as string
        );
        const entries = activity();
        expect(entries[0].value).toBe(1_500_000_000_000_000_000n);
        expect(entries[0].gasUsed).toBe(21_000n);
    });
});

function sample(name: string, status: 'pending' | 'confirmed' | 'reverted', timestamp: number)
{
    return {
        hash: null,
        contractId: 'bridge-usdt',
        contractName: 'BridgeUSDT',
        functionName: name,
        signature: `${ name }(address,uint256)`,
        paramsText: '',
        value: 0n,
        status,
        timestamp,
        blockNumber: null,
        gasUsed: null,
        chainId: 1020
    };
}
