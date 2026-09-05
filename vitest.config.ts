import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The integration suite spawns the built server against real CalDAV
    // containers. It has its own config, its own timeouts and no coverage —
    // leaving it in here would make `npm test` need Docker.
    exclude: [...configDefaults.exclude, 'test/integration/**'],
    // Pinned, because several tests here exist to prove that a timestamp does
    // NOT depend on the host's zone — and a machine whose zone happens to
    // share an offset with the fixture passes them either way. This one sat
    // in `Europe/Luxembourg`, which is `Europe/Berlin` to the second, so the
    // regression test for "a floating RECURRENCE-ID must not be read in the
    // host's zone" was green with the bug still in place. It only failed in
    // CI, where runners are UTC. Pinning makes the local run mean what the CI
    // run means.
    env: { TZ: 'UTC' },
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // Entry point: only wires config and server to the stdio transport and
      // exits the process; not reachable from unit tests.
      exclude: ['src/index.ts'],
      // Measured on 2026-09-05 at 92.13 / 81.55 / 97.24 / 93.76, over 342
      // tests — after the third audit pass, the one run against the second
      // audit's own diff. Set just below, with headroom on functions. Write
      // the missing tests instead of lowering them.
      thresholds: {
        statements: 91,
        branches: 80,
        functions: 92,
        lines: 93,
      },
    },
  },
});
