import { test, expect } from "./fixtures"

test("an unconfigured first run requires the one-time Synthetic Sciences connection", async ({ page, slug }) => {
  await page.route("**/provider", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ all: [], connected: [], default: {} }),
    }),
  )
  await page.route("**/config", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) }),
  )
  await page.route("**/account/session", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ session: false }) }),
  )

  await page.goto(`/${slug}/session/new`)

  await expect(page.getByRole("heading", { name: "Sign in to continue", exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Open Synthetic Sciences", exact: true })).toBeVisible()
  await expect(page.getByLabel("Synthetic Sciences API key", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeDisabled()
  await expect(page.locator('[data-component="prompt-input"]')).toHaveCount(0)
})
