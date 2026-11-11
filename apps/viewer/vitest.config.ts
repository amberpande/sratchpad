import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'viewer',
    environment: 'jsdom',
    include: ['test/**/*.test.tsx'],
    setupFiles: ['../../packages/renderer/test/setup.ts'],
  },
});
