import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'renderer',
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
  },
});
