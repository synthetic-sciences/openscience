import { test, expect } from "./fixtures"
import { openSettings } from "./utils"

const panels = [
  "Models",
  "Local models",
  "Skills",
  "Tools",
  "Connectors",
  "Compute",
  "Security & access",
  "Network",
  "Sandbox",
  "Credentials",
  "Storage",
  "General",
] as const

test("every settings panel loads inside the fixed dialog shell", async ({ page, gotoSession }) => {
  const pageErrors: string[] = []
  page.on("pageerror", (error) => pageErrors.push(error.message))

  await gotoSession()
  const dialog = await openSettings(page)

  for (const panel of panels) {
    await dialog.getByRole("button", { name: panel, exact: true }).click()
    await expect(dialog.locator("header").getByText(panel, { exact: true })).toBeVisible()
    await expect(dialog.getByText("Loading…", { exact: true })).toHaveCount(0)
  }

  await dialog.getByRole("button", { name: "Expand" }).click()
  await expect(dialog.getByRole("button", { name: "Collapse" })).toBeVisible()
  await dialog.getByRole("button", { name: "Collapse" }).click()
  await expect(dialog.getByRole("button", { name: "Expand" })).toBeVisible()

  expect(pageErrors).toEqual([])
})
