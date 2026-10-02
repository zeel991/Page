import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.ts', 'apps/**/test/**/*.test.ts', 'evals/test/**/*.test.ts'],
    environment: 'node',
    // Many tests start PGlite, a twin and real processes; under a fully parallel run
    // the 5s default was hit by load alone, not by a hang.
    testTimeout: 30_000,
  },
});
