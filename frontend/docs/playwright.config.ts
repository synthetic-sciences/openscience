import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "./e2e",
  timeout: 60000,
  retries: 0,
  workers: 1,
  use: { baseURL: "http://127.0.0.1:4179/docs/", viewport: { width: 1440, height: 1000 } },
  webServer: {
    command: "bun run build && bun run preview --host 127.0.0.1 --port 4179 --strictPort",
    url: "http://127.0.0.1:4179/docs/",
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
  },
})
