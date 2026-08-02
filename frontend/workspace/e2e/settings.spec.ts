import { test, expect } from "./fixtures"
import { openSettings } from "./utils"

test("settings dialog navigates between sections and closes", async ({ page, gotoSession }) => {
  await gotoSession()

  const dialog = await openSettings(page)
  // The dialog opens on its first panel, Models.
  await expect(dialog.getByRole("heading", { name: "Models", exact: true })).toBeVisible()

  await dialog.getByRole("button", { name: "General", exact: true }).click()
  await expect(dialog.getByRole("heading", { name: "General" })).toBeVisible()

  const atlas = dialog.getByRole("switch", { name: "Show Atlas", exact: true })
  const trace = dialog.getByRole("switch", { name: "Show Trace", exact: true })
  const atlasControl = atlas.locator("..").locator('[data-slot="switch-control"]')
  await expect(atlas).toBeChecked()
  await expect(trace).not.toBeChecked()
  await atlasControl.click()
  await expect(atlas).not.toBeChecked()
  await atlasControl.click()
  await expect(atlas).toBeChecked()

  const back = dialog.getByRole("button", { name: "Back" })
  const forward = dialog.getByRole("button", { name: "Forward" })
  await expect(back).toBeEnabled()
  await back.click()
  await expect(dialog.getByRole("heading", { name: "Models", exact: true })).toBeVisible()
  await expect(forward).toBeEnabled()
  await forward.click()
  await expect(dialog.getByRole("heading", { name: "General" })).toBeVisible()

  await dialog.getByRole("button", { name: "Close" }).click()
  await expect(dialog).toHaveCount(0)
})
