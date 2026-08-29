import { test, expect } from "./fixtures"
import { openSettings } from "./utils"

test("settings dialog navigates between sections and closes", async ({ page, gotoSession }) => {
  await gotoSession()

  const dialog = await openSettings(page)
  // The dialog opens on its first panel, Models.
  await expect(dialog.getByRole("heading", { name: "Models", exact: true })).toBeVisible()

  await dialog.getByRole("button", { name: "General", exact: true }).click()
  await expect(dialog.getByRole("heading", { name: "General" })).toBeVisible()
  await expect(dialog.getByRole("heading", { name: "Account", exact: true })).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Switch workspace", exact: true })).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Open billing", exact: true })).toBeVisible()
  const sounds = dialog.getByRole("button", { name: "Show sound settings", exact: true })
  await expect(sounds).toBeVisible()
  await sounds.click()
  await expect(dialog.getByRole("button", { name: "Hide sound settings", exact: true })).toBeVisible()

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

test("narrow settings menu owns its first Escape press", async ({ page, gotoSession }) => {
  await gotoSession()

  const dialog = await openSettings(page)
  await page.setViewportSize({ width: 560, height: 800 })
  const menu = dialog.locator(".settings-nav__mobile-trigger")
  await menu.click()
  await expect(menu).toHaveAttribute("aria-expanded", "true")

  await menu.press("Escape")
  await expect(dialog).toBeVisible()
  await expect(menu).toBeFocused()
  await expect(menu).toHaveAttribute("aria-expanded", "false")

  await menu.press("Escape")
  await expect(dialog).toHaveCount(0)
})
