import { defineConfig } from 'vitest/config';

// The opt-in suite against the vendors' real APIs. Not part of pnpm verify.
export default defineConfig({
  test: {
    include: ['evals/contract/**/*.contract.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
  },
});
