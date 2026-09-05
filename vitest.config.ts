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
      // MEASURE FIRST, then set these just below the actual values (leave ~5
      // points headroom on functions). Write the missing tests instead of
      // lowering them.
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90,
      },
    },
  },
});
