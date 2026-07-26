import { test, expect } from "./fixtures"
import { serverName } from "./utils"

test("home renders and shows core entrypoints", async ({ page }) => {
  await page.goto("/")

  await expect(page.getByRole("button", { name: /new project/i }).first()).toBeVisible()
  await expect(page.getByRole("button", { name: serverName })).toBeVisible()
})

test("server picker dialog opens from home", async ({ page }) => {
  await page.goto("/")

  const trigger = page.getByRole("button", { name: serverName })
  await expect(trigger).toBeVisible()
  await trigger.click()

  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole("textbox").first()).toBeVisible()
})

test("keyboard help opens and closes accessibly", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByRole("button", { name: serverName })).toBeVisible()
  await page.keyboard.press("Shift+Slash")

  const dialog = page.getByRole("dialog", { name: "keyboard shortcuts" })
  await expect(dialog).toBeVisible()

  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
})
