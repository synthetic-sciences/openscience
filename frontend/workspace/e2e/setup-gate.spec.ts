import { test, expect } from "./fixtures"
import { openSettings } from "./utils"

test("an unconfigured first run stays local and exposes model setup in Customize", async ({ page, gotoSession }) => {
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

  await gotoSession()

  await expect(page.getByRole("dialog", { name: "Set up models" })).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => localStorage.getItem("openscience.setup.dismissed"))).toBeNull()

  const dialog = await openSettings(page)
  await expect(dialog.getByRole("heading", { name: "Models", exact: true })).toBeVisible()
  await expect(dialog.getByRole("heading", { name: "ChatGPT / Codex" })).toBeVisible()
  await expect(dialog.getByRole("heading", { name: "Provider keys" })).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Save key", exact: true })).toBeDisabled()
})
