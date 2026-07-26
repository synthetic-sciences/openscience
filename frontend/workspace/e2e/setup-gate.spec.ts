import { test, expect } from "./fixtures"

test("first-run setup offers every path and remembers dismissal", async ({ page, gotoSession }) => {
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

  const dialog = page.getByRole("dialog", { name: "Set up models" })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole("button", { name: /Atlas managed/ })).toBeVisible()
  await expect(dialog.getByRole("button", { name: /Your own keys/ })).toBeVisible()
  await expect(dialog.getByRole("button", { name: /Not now/ })).toBeVisible()

  await dialog.getByRole("button", { name: /Your own keys/ }).click()
  await expect(dialog.getByText("Add a provider key.", { exact: false })).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Anthropic", exact: true })).toBeVisible()
  await expect(dialog.getByRole("button", { name: "OpenAI", exact: true })).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Google", exact: true })).toBeVisible()
  await expect(dialog.getByRole("button", { name: "OpenRouter", exact: true })).toBeVisible()
  await expect(dialog.getByRole("button", { name: "save key", exact: true })).toBeDisabled()

  await dialog.getByRole("button", { name: "back", exact: true }).click()
  await dialog.getByRole("button", { name: /Not now/ }).click()
  await expect(dialog).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => localStorage.getItem("openscience.setup.dismissed"))).toBe("1")

  await page.reload()
  await expect(page.getByRole("dialog", { name: "Set up models" })).toHaveCount(0)
})
