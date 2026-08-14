import { test, expect } from "./fixtures"
import { serverName, serverUrl } from "./utils"

const DEFAULT_SERVER_URL_KEY = "openscience.settings.dat:defaultServerUrl"

test("can set a default server on web", async ({ page }) => {
  await page.addInitScript((key: string) => {
    try {
      localStorage.removeItem(key)
    } catch {
      return
    }
  }, DEFAULT_SERVER_URL_KEY)

  await page.goto("/")
  const trigger = page.getByRole("button", { name: serverName, exact: true })
  await expect(trigger).toBeVisible()
  await trigger.click()

  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()

  const row = dialog.locator('[data-slot="list-item"]').filter({ hasText: serverName }).first()
  await expect(row).toBeVisible()

  const menu = row.locator('[data-component="icon-button"]').last()
  await menu.click()
  await page.locator('[data-slot="dropdown-menu-item"]').filter({ hasText: "set as default" }).click()

  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), DEFAULT_SERVER_URL_KEY)).toBe(serverUrl)
  await expect(row.getByText("Default", { exact: true })).toBeVisible()

  await dialog.getByRole("button", { name: "Close" }).click()
  await expect(dialog).toHaveCount(0)

  await trigger.click()
  const serverRow = page.getByRole("dialog").locator('[data-slot="list-item"]').filter({ hasText: serverName }).first()
  await expect(serverRow).toBeVisible()
  await expect(serverRow.getByText("Default", { exact: true })).toBeVisible()
})
