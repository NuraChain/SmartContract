// The one route table: the client router, the SSR entry, and the prerenderer
// all read it, so there is no second manifest. The dashboard prerenders; the
// workbench pages depend on wallet and live chain state and ship lazy.

import type { PageRoute } from '@azerothjs/kit';

import Dashboard from './pages/dashboard.azeroth';

export const routes: PageRoute[] = [
    { path: '/', component: Dashboard, render: 'static' },
    { path: '/contracts', lazy: () => import('./pages/contracts.azeroth'), render: 'client' },
    { path: '/contracts/:id', lazy: () => import('./pages/contract-detail.azeroth'), render: 'client' },
    { path: '/activity', lazy: () => import('./pages/activity.azeroth'), render: 'client' }
];
