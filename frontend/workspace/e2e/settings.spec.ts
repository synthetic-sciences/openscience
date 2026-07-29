import { test, expect } from "./fixtures"

test("settings dialog navigates between sections and closes", async ({ page, gotoSession }) => {
  await gotoSession()

  await page.getByRole("button", { name: "More", exact: true }).click()
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByRole("heading", { name: "Connectors" })).toBeVisible()

  await dialog.getByRole("button", { name: "General", exact: true }).click()
  await expect(dialog.getByRole("heading", { name: "General" })).toBeVisible()

  const back = dialog.getByRole("button", { name: "Back" })
  const forward = dialog.getByRole("button", { name: "Forward" })
  await expect(back).toBeEnabled()
  await back.click()
  await expect(dialog.getByRole("heading", { name: "Connectors" })).toBeVisible()
  await expect(forward).toBeEnabled()
  await forward.click()
  await expect(dialog.getByRole("heading", { name: "General" })).toBeVisible()

  await dialog.getByRole("button", { name: "Close" }).click()
  await expect(dialog).toHaveCount(0)
})
