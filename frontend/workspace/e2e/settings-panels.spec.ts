import { test, expect } from "./fixtures"

const panels = [
  "Connectors",
  "Specialists",
  "Memory",
  "Compute",
  "Local models",
  "Network",
  "Permissions",
  "Sandbox",
  "Credentials",
  "Billing",
  "Storage",
  "General",
] as const

test("every settings panel loads inside the fixed dialog shell", async ({ page, gotoSession }) => {
  const pageErrors: string[] = []
  page.on("pageerror", (error) => pageErrors.push(error.message))

  await gotoSession()
  await page.getByRole("button", { name: "settings", exact: true }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()

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
