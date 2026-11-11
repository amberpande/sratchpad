import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'studio',
    environment: 'jsdom',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    setupFiles: ['../../packages/renderer/test/setup.ts'],
  },
});
