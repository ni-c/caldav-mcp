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
      // Measured on 2026-09-07 at 97.93 / 89.26 / 99.74 / 99.16, over 464
      // tests — after the second hardening pass, which wrote a test for
      // every branch a caller or the backend can reach and left the rest
      // (a packageVersion() fallback, a URL join that cannot throw) alone.
      // Set just below, with a point of headroom on branches. Write the
      // missing tests instead of lowering them.
      thresholds: {
        statements: 97,
        branches: 88,
        functions: 99,
        lines: 98,
      },
    },
  },
});
