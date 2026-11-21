import { defineConfig, devices } from '@playwright/test';

// UNVERIFIED: requires Postgres + Redis (see docker-compose.yml / CI). Starts API, worker and web itself.
export default defineConfig({
  testDir: './e2e', timeout: 60_000, fullyParallel: false, retries: process.env.CI ? 1 : 0, reporter: [['list']],
  use: { baseURL: 'http://localhost:3000', trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    { command: 'pnpm --filter @contractguard/api start', port: 4000, reuseExistingServer: !process.env.CI, cwd: '../..' },
    { command: 'pnpm --filter @contractguard/worker start', url: 'http://localhost:4000/api/rules', reuseExistingServer: !process.env.CI, cwd: '../..' },
    { command: 'pnpm --filter @contractguard/web build && pnpm --filter @contractguard/web start', port: 3000, reuseExistingServer: !process.env.CI, cwd: '../..', timeout: 240_000 },
  ],
});
