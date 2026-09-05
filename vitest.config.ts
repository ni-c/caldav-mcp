import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The integration suite spawns the built server against real CalDAV
    // containers. It has its own config, its own timeouts and no coverage —
    // leaving it in here would make `npm test` need Docker.
    exclude: [...configDefaults.exclude, 'test/integration/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // Entry point: only wires config and server to the stdio transport and
      // exits the process; not reachable from unit tests.
      exclude: ['src/index.ts'],
      // Measured on 2026-09-05 at 89.39 / 77.33 / 93.25 / 91.37, over 276
      // tests. Set just below, with headroom on functions. Write the missing
      // tests instead of lowering them.
      thresholds: {
        statements: 88,
        branches: 75,
        functions: 88,
        lines: 90,
      },
    },
  },
});
