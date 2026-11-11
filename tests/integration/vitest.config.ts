import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'integration',
    environment: 'jsdom',
    include: ['*.test.tsx'],
    setupFiles: ['../../packages/renderer/test/setup.ts'],
  },
});
