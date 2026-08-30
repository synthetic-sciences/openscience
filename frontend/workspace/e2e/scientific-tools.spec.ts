import { expect, test } from "./fixtures"
import { openSettings } from "./utils"

test("shows only runnable scientific tools with direct setup actions", async ({ page, gotoSession }) => {
  await gotoSession()
  const dialog = await openSettings(page)

  await dialog.getByRole("button", { name: "Tools", exact: true }).click()
  await expect(dialog.getByRole("heading", { name: "Tools", exact: true })).toBeVisible()

  await expect(dialog.getByRole("heading", { name: "Local science", exact: true })).toBeVisible()
  await expect(dialog.getByRole("heading", { name: "Connected science", exact: true })).toBeVisible()
  await expect(dialog.locator(".scientific-tool-row")).toHaveCount(15)
  await expect(dialog.getByText("AlphaFold2", { exact: true })).toHaveCount(0)
  await expect(dialog.getByText("Open Babel", { exact: true })).toHaveCount(0)

  const boltz = dialog.locator(".scientific-tool-row").filter({ hasText: "Boltz-2" })
  await expect(boltz.getByRole("button", { name: "Connect", exact: true })).toBeVisible()
  await boltz.getByRole("button", { name: "Connect", exact: true }).click()
  await expect(dialog.getByRole("heading", { name: "Credentials", exact: true })).toBeVisible()
})
