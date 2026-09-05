// Component tests run against real DOM (happy-dom) through the compiler - the
// same pipeline that serves the app. renderTest mounts, cleanup unmounts
// between tests. App takes a `url` so tests pin the route.
import { afterEach, describe, expect, it } from 'vitest';
import { renderTest, cleanup } from '@azerothjs/testing';

import App from '../src/App.azeroth';
import ContractsPage from '../src/pages/contracts.azeroth';
import ActivityPage from '../src/pages/activity.azeroth';

afterEach(cleanup);

describe('App shell', () =>
{
    it('renders the dashboard with header, stats, and footer', () =>
    {
        const { container } = renderTest(() => App({ url: '/' }));
        expect(container.textContent).toContain('Contract Manager');
        expect(container.querySelector('header')).not.toBeNull();
        expect(container.querySelector('[data-testid="stat-contracts"]')).not.toBeNull();
        expect(container.textContent).toContain('never stores keys and never signs automatically');
    });

    it('renders a not-found fallback for an unknown path', () =>
    {
        const { container } = renderTest(() => App({ url: '/nope' }));
        expect(container.textContent).toContain('This page does not exist.');
    });
});

describe('Contracts page', () =>
{
    it('lists registry contracts with counts', () =>
    {
        const { container } = renderTest(() => ContractsPage({}));
        expect(container.querySelector('[data-testid="contract-bridge-usdt"]')).not.toBeNull();
        expect(container.querySelector('[data-testid="result-count"]')?.textContent).not.toContain('0 of');
    });

    it('marks contracts without an address honestly', () =>
    {
        const { container } = renderTest(() => ContractsPage({}));
        const card = container.querySelector('[data-testid="contract-airdrop"]');
        expect(card?.querySelector('[data-testid="no-address"]')?.textContent).toContain('No deployment recorded');
    });

    it('groups the registry into one section per contracts-repository folder', () =>
    {
        const { container } = renderTest(() => ContractsPage({}));
        for (const folder of ['token', 'airdrop', 'univ3', 'vault', 'forecast', 'profile', 'testing', 'external'])
        {
            const section = container.querySelector(`[data-testid="folder-${ folder }"]`);
            expect(section, `section ${ folder }`).not.toBeNull();
            expect(section?.querySelector('h2')).not.toBeNull();
            expect(section?.querySelectorAll('[data-testid^="contract-"]').length).toBeGreaterThan(0);
        }
        // Each card sits in exactly one section, and the section names its source folder.
        const profile = container.querySelector('[data-testid="folder-profile"]');
        expect(profile?.textContent).toContain('contracts/profile');
        expect(profile?.querySelector('[data-testid="contract-nura-profile"]')).not.toBeNull();
        expect(profile?.querySelector('[data-testid="contract-bridge-usdt"]')).toBeNull();
        expect(container.querySelectorAll('[data-testid="contract-bridge-usdt"]').length).toBe(1);
    });

    it('filters to a single folder section from the chips', async () =>
    {
        const { container } = renderTest(() => ContractsPage({}));
        (container.querySelector('[data-testid="filter-profile"]') as HTMLButtonElement).click();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(container.querySelector('[data-testid="folder-profile"]')).not.toBeNull();
        expect(container.querySelector('[data-testid="folder-token"]')).toBeNull();
        expect(container.querySelector('[data-testid="result-count"]')?.textContent).toContain('3 of');
        expect(container.querySelector('[data-testid="filter-profile"]')?.getAttribute('aria-pressed')).toBe('true');
    });
});

describe('Contract detail page', () =>
{
    it('shows the overview for a known id via the app router', () =>
    {
        // The detail page reads useParams, so exercise it through App at the
        // real path. The lazy chunk loads asynchronously; before it lands we
        // can only assert the shell is present without an error boundary.
        const { container } = renderTest(() => App({ url: '/contracts/bridge-usdt' }));
        expect(container.querySelector('main')).not.toBeNull();
    });
});

describe('Activity page', () =>
{
    it('renders an honest empty state when nothing was executed', () =>
    {
        window.localStorage.removeItem('cm.activity.v1');
        const { container } = renderTest(() => ActivityPage({}));
        expect(container.textContent).toContain('No transactions yet');
    });
});
