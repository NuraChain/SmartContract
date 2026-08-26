// @vitest-environment node
//
// The SSR/prerender bundle evaluates EVERY page module - render: 'client' does
// not exempt one. A single module-scope window/localStorage/EventTarget touch
// anywhere in the import graph kills the production build. This spec imports
// the whole page graph under plain Node, where any such touch throws.

import { describe, expect, it } from 'vitest';

describe('ssr safety', () =>
{
    // Generous timeout: the first import cold-compiles the entire component
    // graph - every page, every component, and viem underneath them.
    it('every page module imports cleanly without a DOM', { timeout: 120_000 }, async () =>
    {
        await expect(import('../src/App.azeroth')).resolves.toBeDefined();
        await expect(import('../src/pages/dashboard.azeroth')).resolves.toBeDefined();
        await expect(import('../src/pages/contracts.azeroth')).resolves.toBeDefined();
        await expect(import('../src/pages/contract-detail.azeroth')).resolves.toBeDefined();
        await expect(import('../src/pages/activity.azeroth')).resolves.toBeDefined();
        await expect(import('../src/lib/wallet/store.ts')).resolves.toBeDefined();
        await expect(import('../src/lib/tx-manager.ts')).resolves.toBeDefined();
        await expect(import('../src/lib/history.ts')).resolves.toBeDefined();
        await expect(import('../src/lib/theme.ts')).resolves.toBeDefined();
        await expect(import('../src/config/contracts.ts')).resolves.toBeDefined();
    });
});
