import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  reporter: [['list', { printSteps: true }]],
  use: { channel: process.env.ROSTER_READY_BROWSER },
});
