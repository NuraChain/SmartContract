// The activity log: transactions initiated FROM this interface. Stored locally
// (localStorage) as non-sensitive metadata only - function, contract, hash,
// status, timestamp. No keys, no signatures, no wallet state.

import { createSignal } from 'azerothjs';

import type { Address } from 'viem';

export interface ActivityEntry
{
    id: string;
    hash: Address | null;
    contractId: string;
    contractName: string;
    functionName: string;
    signature: string;
    /** Human-readable parameter summary, safe to store. */
    paramsText: string;
    /** Native value attached, in wei. */
    value: bigint;
    status: 'pending' | 'confirmed' | 'reverted';
    timestamp: number;
    blockNumber: number | null;
    gasUsed: bigint | null;
    chainId: number;
}

const STORAGE_KEY = 'cm.activity.v1';
const MAX_ENTRIES = 100;

const [entriesSignal, setEntries] = createSignal<ActivityEntry[]>([]);
let loaded = false;

function load(): ActivityEntry[]
{
    if (!loaded)
    {
        loaded = true;
        try
        {
            const raw = window.localStorage.getItem(STORAGE_KEY);
            if (raw !== null)
            {
                const parsed = JSON.parse(raw) as ActivityEntry[];
                // bigint fields do not survive JSON; revive the ones we stored
                // as strings.
                setEntries(parsed.map((entry) => ({
                    ...entry,
                    value: BigInt((entry.value as unknown as string) ?? '0'),
                    gasUsed: entry.gasUsed === null ? null : BigInt(entry.gasUsed as unknown as string)
                })));
            }
        }
        catch
        {
            setEntries([]);
        }
    }
    return entriesSignal();
}

function persist(entries: ActivityEntry[]): void
{
    try
    {
        window.localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify(entries, (_key, value) => typeof value === 'bigint' ? value.toString() : value)
        );
    }
    catch
    {
        // Storage unavailable - the log lives for this session only.
    }
    setEntries(entries);
}

export function activity(): ActivityEntry[]
{
    return load();
}

export function recordActivity(input: Omit<ActivityEntry, 'id'>): string
{
    const id = `${ Date.now().toString(36) }-${ Math.random().toString(36).slice(2, 8) }`;
    persist([ { ...input, id }, ...load() ].slice(0, MAX_ENTRIES));
    return id;
}

export function updateActivity(id: string, patch: Partial<ActivityEntry>): void
{
    persist(load().map((entry) => entry.id === id ? { ...entry, ...patch } : entry));
}

/** Removes a never-submitted entry (wallet rejected before a hash existed). */
export function dropActivity(id: string): void
{
    persist(load().filter((entry) => entry.id !== id));
}

export function clearActivity(): void
{
    persist([]);
}
