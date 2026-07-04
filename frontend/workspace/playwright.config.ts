import { defineConfig, devices } from "@playwright/test"

const port = Number(process.env.PLAYWRIGHT_PORT ?? 3000)
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${port}`
const serverHost = process.env.PLAYWRIGHT_SERVER_HOST ?? "localhost"
const serverPort = process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"
// Basic-Auth creds for the in-process openscience server. e2e-local.ts pins both
// OPENSCIENCE_SERVER_* (server side) and VITE_OPENSCIENCE_SERVER_* (frontend side) to
// the same value so the Playwright-hosted frontend can authenticate.
const serverUsername = process.env.VITE_OPENSCIENCE_SERVER_USERNAME ?? "openscience"
const serverPassword = process.env.VITE_OPENSCIENCE_SERVER_PASSWORD ?? ""
const command = `bun run dev -- --host 0.0.0.0 --port ${port}`
const reuse = !process.env.CI

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./e2e/test-results",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [["html", { outputFolder: "e2e/playwright-report", open: "never" }], ["line"]],
  webServer: {
    command,
    url: baseURL,
    reuseExistingServer: reuse,
    timeout: 120_000,
    env: {
      VITE_OPENSCIENCE_SERVER_HOST: serverHost,
      VITE_OPENSCIENCE_SERVER_PORT: serverPort,
      VITE_OPENSCIENCE_SERVER_USERNAME: serverUsername,
      VITE_OPENSCIENCE_SERVER_PASSWORD: serverPassword,
    },
  },
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    // Inject Basic-Auth on every browser request. The frontend's
    // openscience-fetch.ts wraps fetch() with the same header, but its
    // dev-mode gate + port-match check is fragile under windows-latest
    // env-var propagation. Setting the header at the Playwright layer
    // bypasses both gates and is independent of how Vite resolves env.
    extraHTTPHeaders: serverPassword
      ? { Authorization: `Basic ${Buffer.from(`${serverUsername}:${serverPassword}`).toString("base64")}` }
      : undefined,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
})
