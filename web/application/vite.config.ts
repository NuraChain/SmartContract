import { azeroth } from '@azerothjs/compiler';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';

// No dev proxy: this application talks to the chain directly from the browser
// over the RPC in src/config/chain.ts. There is no API half to wire.

export default defineConfig({
    plugins: [azeroth(), tailwindcss()],
    // The SSR bundle (src/entry.server.ts) inlines its dependencies, so dist-server
    // is ONE self-contained file - the prerenderer imports it with no node_modules.
    ssr:
    {
        noExternal: true
    },
    server:
    {
        port: 7001
    },
    test:
    {
        environment: 'happy-dom',
        coverage:
        {
            provider: 'v8',
            include: ['src/**/*.{ts,azeroth}'],
            exclude: ['src/vite-env.d.ts', 'src/entry.server.ts'],
            reporter: ['text-summary', 'json-summary', 'html'],
            reportsDirectory: 'coverage'
        }
    }
});
