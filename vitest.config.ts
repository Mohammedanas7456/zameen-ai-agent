import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      // Tests read shared's source directly, so they neither depend on a prior
      // build nor risk asserting against a stale one. Production resolution is
      // unaffected: the package's own exports point at dist/ for plain Node.
      '@zameen/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    environment: 'node',
  },
});
