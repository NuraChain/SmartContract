// The wallet store: EIP-6963 discovery, connection state, native balance, and
// the account/chain event wiring. SSR-safe by construction - nothing here
// touches window at module scope, and discovery starts only when the UI asks.
//
// Refresh model: receipts and a 5s visible-tab timer, never per-block.

import { createSignal } from 'azerothjs';
import { createWalletClient, custom } from 'viem';
import type { WalletClient } from 'viem';

import { NURA_CHAIN, addChainParams } from '../../config/chain.ts';
import type { Address } from 'viem';
import { classifyError } from '../errors.ts';
import { pushToast, resolveToast } from '../toast.ts';
import { publicClient } from '../chain-client.ts';

export interface Eip1193Provider
{
    request: (args: { method: string; params?: unknown[] | object }) => Promise<unknown>;
    on?: (event: string, handler: (payload: never) => void) => void;
    removeListener?: (event: string, handler: (payload: never) => void) => void;
}

// Keyed by rdns, the identity EIP-6963 exists to provide: every announced
// wallet is admitted - hard-coded brand lists are what made installed wallets
// report "not detected".
export interface WalletOption
{
    id: string;
    name: string;
    icon: string | null;
    provider: Eip1193Provider | null;
}

interface Eip6963Detail
{
    info: { uuid: string; name: string; icon: string; rdns: string };
    provider: Eip1193Provider;
}

const SESSION_KEY = 'cm.wallet';

function readSession(): string | null
{
    try
    {
        return window.localStorage.getItem(SESSION_KEY);
    }
    catch
    {
        return null;
    }
}

function writeSession(rdns: string | null): void
{
    try
    {
        if (rdns === null)
        {
            window.localStorage.removeItem(SESSION_KEY);
        }
        else
        {
            window.localStorage.setItem(SESSION_KEY, rdns);
        }
    }
    catch
    {
        // Session lives for this load only.
    }
}

const [optionsSignal, setOptions] = createSignal<WalletOption[]>([]);
const [accountSignal, setAccount] = createSignal<Address | null>(null);
const [chainIdSignal, setChainId] = createSignal<number | null>(null);
const [connectedViaSignal, setConnectedVia] = createSignal<string | null>(null);
const [nativeBalanceSignal, setNativeBalance] = createSignal<bigint | null>(null);
const [txEpochSignal, setTxEpoch] = createSignal(0);

let walletClient: WalletClient | null = null;
let activeProvider: Eip1193Provider | null = null;
let discoveryStarted = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
// Providers already bound to accountsChanged/chainChanged/disconnect. A second
// connect of the same wallet must not stack a second set of listeners - each
// would fire its own refresh and, worse, its own disconnect() on one event.
const boundProviders = new WeakSet<Eip1193Provider>();

export const walletOptions = optionsSignal;
export const account = accountSignal;
export const walletChainId = chainIdSignal;
export const connectedVia = connectedViaSignal;
export const nativeBalance = nativeBalanceSignal;
// Bumped after every settled transaction and every poll tick - pages hang
// their refreshes on this.
export const txEpoch = txEpochSignal;

export function isConnected(): boolean
{
    return walletClient !== null;
}

/** One more completed piece of chain activity - refresh hook for pages. */
export function bumpTxEpoch(): void
{
    setTxEpoch(txEpochSignal() + 1);
}

export function requiredWallet(): WalletClient
{
    if (walletClient === null)
    {
        throw new Error('wallet not connected');
    }
    return walletClient;
}

export function startDiscovery(): void
{
    if (discoveryStarted || typeof window === 'undefined')
    {
        return;
    }
    discoveryStarted = true;
    const savedRdns = readSession();
    window.addEventListener('eip6963:announceProvider', (event) =>
    {
        const detail = (event as CustomEvent<Eip6963Detail>).detail;
        const rdns = detail.info.rdns || detail.info.uuid;
        if (optionsSignal().some((option) => option.id === rdns))
        {
            return;
        }
        const option: WalletOption = { id: rdns, name: detail.info.name, icon: detail.info.icon, provider: detail.provider };
        setOptions([...optionsSignal(), option]);
        // A remembered wallet restores silently: eth_accounts never prompts.
        if (rdns === savedRdns && accountSignal() === null)
        {
            void restoreSession(option);
        }
    });
    window.dispatchEvent(new Event('eip6963:requestProvider'));
}

async function restoreSession(option: WalletOption): Promise<void>
{
    if (option.provider === null)
    {
        return;
    }
    try
    {
        const accounts = await option.provider.request({ method: 'eth_accounts' }) as string[];
        if (accounts.length === 0)
        {
            return;
        }
        adoptAccount(option.provider, accounts[0] as Address);
        const chainIdHex = await option.provider.request({ method: 'eth_chainId' }) as string;
        setChainId(Number(chainIdHex));
        setConnectedVia(option.name);
        bindProviderEvents(option.provider);
        startPolling();
        void refreshBalance();
    }
    catch
    {
        writeSession(null);
    }
}

function startPolling(): void
{
    if (pollTimer !== null || typeof window === 'undefined')
    {
        return;
    }
    pollTimer = setInterval(() =>
    {
        if (!document.hidden && accountSignal() !== null)
        {
            void syncAccount();
            void refreshBalance();
            setTxEpoch(txEpochSignal() + 1);
        }
    }, 5000);
}

/**
 * Event delivery is not guaranteed - a locked extension, a reconnect cycle,
 * or a wallet that simply never emitted accountsChanged would leave the UI
 * signed into an account the user has already moved away from. Each tick asks
 * eth_accounts (silent by spec, never prompts) and reconciles with whatever
 * the wallet now reports.
 */
async function syncAccount(): Promise<void>
{
    const provider = activeProvider;
    const current = accountSignal();
    if (provider === null || current === null)
    {
        return;
    }
    try
    {
        const accounts = await provider.request({ method: 'eth_accounts' }) as string[];
        // A connect/disconnect raced this request; its answer is stale.
        if (accountSignal() !== current)
        {
            return;
        }
        if (accounts.length === 0)
        {
            disconnect();
            return;
        }
        const next = accounts[0] as Address;
        if (next.toLowerCase() !== current.toLowerCase())
        {
            adoptAccount(provider, next);
            void refreshBalance();
        }
    }
    catch
    {
        // Transient provider failure - the next tick retries.
    }
}

function stopPolling(): void
{
    if (pollTimer !== null)
    {
        clearInterval(pollTimer);
        pollTimer = null;
    }
}

export async function refreshBalance(): Promise<void>
{
    const owner = accountSignal();
    if (owner === null)
    {
        return;
    }
    try
    {
        setNativeBalance(await publicClient().getBalance({ address: owner }));
    }
    catch
    {
        // Transient RPC failure - the next tick retries.
    }
}

// The signing client and the account signal move TOGETHER, through here. They
// must never be assigned side by side at a call site: an accountsChanged that
// updated only the signal would leave every write signed as the account the
// user had switched away FROM.
function adoptAccount(provider: Eip1193Provider, address: Address): void
{
    activeProvider = provider;
    walletClient = createWalletClient({
        account: address,
        chain: NURA_CHAIN,
        transport: custom(provider as never)
    });
    setAccount(address);
}

function bindProviderEvents(provider: Eip1193Provider): void
{
    if (boundProviders.has(provider))
    {
        return;
    }
    boundProviders.add(provider);
    provider.on?.('accountsChanged', (accounts: never) =>
    {
        const list = accounts as unknown as string[];
        if (list.length === 0)
        {
            disconnect();
            return;
        }
        adoptAccount(provider, list[0] as Address);
        void refreshBalance();
    });
    provider.on?.('chainChanged', (chainIdHex: never) =>
    {
        setChainId(Number(chainIdHex as unknown as string));
    });
    provider.on?.('disconnect', () => disconnect());
}

/**
 * Connects an announced wallet. Resolves FALSE when nothing connected - a
 * declined prompt or a locked wallet - so a caller can keep its sheet open.
 */
export async function connectInjected(option: WalletOption): Promise<boolean>
{
    if (option.provider === null)
    {
        return false;
    }
    // The wallet prompt goes FIRST, while the click's user activation is still
    // live. Awaiting anything before it spends that activation, and a wallet
    // that has lost it may queue its approval window behind its toolbar icon.
    let accounts: string[];
    try
    {
        accounts = await option.provider.request({ method: 'eth_requestAccounts' }) as string[];
    }
    catch (error)
    {
        // 4001 is "user rejected": their own wallet already said so, so we stay
        // quiet. -32002 is a request ALREADY waiting in the wallet - the one case
        // where clicking again genuinely looks like nothing happening.
        const code = (error as { code?: number }).code;
        if (code === -32002)
        {
            pushToast('error', 'A connection request is already waiting in your wallet.');
        }
        else if (code !== 4001)
        {
            pushToast('error', classifyError(error).title);
        }
        return false;
    }
    if (accounts.length === 0)
    {
        // A locked wallet answers an empty list rather than rejecting.
        pushToast('error', 'The wallet is locked. Unlock it and connect again.');
        return false;
    }
    adoptAccount(option.provider, accounts[0] as Address);
    const chainIdHex = await option.provider.request({ method: 'eth_chainId' }) as string;
    setChainId(Number(chainIdHex));
    setConnectedVia(option.name);
    writeSession(option.id);
    bindProviderEvents(option.provider);
    startPolling();
    void refreshBalance();
    return true;
}

// Test hook: install a ready-made client without EIP-6963.
export function adoptWallet(clientToAdopt: WalletClient, address: Address, chainId: number, label: string): void
{
    walletClient = clientToAdopt;
    activeProvider = null;
    setAccount(address);
    setChainId(chainId);
    setConnectedVia(label);
    startPolling();
    void refreshBalance();
}

export function disconnect(): void
{
    const provider = activeProvider;
    walletClient = null;
    activeProvider = null;
    setAccount(null);
    setChainId(null);
    setConnectedVia(null);
    setNativeBalance(null);
    writeSession(null);
    // The 5s poll has nothing to refresh without an account.
    stopPolling();
    // Clearing local state alone leaves the wallet's eth_accounts permission
    // alive: the next connect would silently resume THIS account and there
    // would be no way to switch wallets. Revoking sends the site back to the
    // "not connected" list, so eth_requestAccounts prompts again. Fire and
    // forget - wallets without revoke support simply stay permitted.
    if (provider !== null)
    {
        void provider
            .request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] })
            .catch(() =>
            {
                // Best effort only; the session is already cleared locally.
            });
    }
}

export function onRightChain(): boolean
{
    return chainIdSignal() === NURA_CHAIN.id;
}

/**
 * Asks the wallet to switch to Nura Chain, registering it first when the
 * wallet does not know it. Resolves false when the user declined.
 */
export async function switchChain(): Promise<boolean>
{
    if (activeProvider === null)
    {
        // Nothing real to switch; tests/dev clients are pinned by construction.
        setChainId(NURA_CHAIN.id);
        return true;
    }
    const hexId = `0x${ NURA_CHAIN.id.toString(16) }`;
    try
    {
        await activeProvider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexId }] });
    }
    catch (error)
    {
        // "Unknown chain" is 4902 by spec but wallets disagree in practice -
        // forks answer -32603 or 4200 for the same condition - so the fallback
        // fires on anything that is NOT an explicit refusal. Catching everything
        // meant a DECLINED switch was answered by immediately asking to add the
        // chain: a second prompt for someone who had just said no.
        if (classifyError(error).code === 'user-rejected')
        {
            pushToast('info', 'Network switch declined - still on the wrong network.');
            return false;
        }
        try
        {
            await activeProvider.request({
                method: 'wallet_addEthereumChain',
                params: [addChainParams()]
            });
        }
        catch (addError)
        {
            if (classifyError(addError).code !== 'user-rejected')
            {
                pushToast('error', classifyError(addError).title);
            }
            return false;
        }
    }
    setChainId(NURA_CHAIN.id);
    return true;
}

/**
 * Registers the chain in the connected wallet WITHOUT switching. For the
 * person who wants the network in their wallet list before connecting.
 */
export async function addChainToWallet(): Promise<void>
{
    const announced = optionsSignal()
        .map((option) => option.provider)
        .filter((provider): provider is Eip1193Provider => provider !== null);
    const provider = activeProvider ?? (announced.length === 1 ? announced[0] : null);
    if (provider === null)
    {
        pushToast('error', 'No wallet available to register the network with.');
        return;
    }
    try
    {
        await provider.request({
            method: 'wallet_addEthereumChain',
            params: [addChainParams()]
        });
        pushToast('success', 'Nura Chain added to your wallet.');
    }
    catch (error)
    {
        // A declined prompt is a normal outcome here; anything else is not.
        if (classifyError(error).code !== 'user-rejected')
        {
            pushToast('error', classifyError(error).title);
        }
    }
}

/** Toast plumbing shared with the transaction manager. */
export function toastPending(text: string): number
{
    return pushToast('pending', text);
}

export function toastResolve(
    id: number,
    kind: 'success' | 'error' | 'info',
    text: string,
    link?: { href: string; label: string }
): void
{
    resolveToast(id, kind, text, link);
}
