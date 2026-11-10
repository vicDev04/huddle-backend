import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    globalSetup: './test/global-setup.js',
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:5432/huddle_test',
      FRONTEND_ORIGINS: 'http://localhost:5500,http://127.0.0.1:5500,https://localhost,capacitor://localhost',
      DISABLE_RATE_LIMIT: 'true',
      JWT_SECRET: 'test-secret',
    },
  },
});
