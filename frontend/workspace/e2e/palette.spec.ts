import { test, expect } from "./fixtures"
import { modKey } from "./utils"

test("search palette opens and closes", async ({ page, gotoSession }) => {
  await gotoSession()

  await page.keyboard.press(`${modKey}+K`)

  const dialog = page.getByRole("dialog", { name: "command palette" })
  const search = dialog.getByRole("textbox", { name: "search commands and projects" })
  await expect(dialog).toBeVisible()
  await expect(search).toBeVisible()
  await expect(dialog.getByRole("button", { name: /Settings/ })).toBeVisible()

  await page.keyboard.press("Escape")
  await expect(search).toHaveCount(0)
})
