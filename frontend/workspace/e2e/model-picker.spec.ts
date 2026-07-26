import { test, expect } from "./fixtures"
import { promptSelector } from "./utils"

test("smoke model selection updates prompt footer", async ({ page, gotoSession }) => {
  await gotoSession()

  const form = page.locator(promptSelector).locator("xpath=ancestor::form[1]")
  const trigger = form.locator('button[aria-haspopup="dialog"]:has([data-component="provider-icon"])').first()
  await expect(trigger).toBeVisible()
  await trigger.click()

  const dialog = page.getByRole("dialog", { name: "select model" })
  await expect(dialog).toBeVisible()

  const target = dialog.locator('[data-slot="list-item"]').first()
  await expect(target).toBeVisible()

  const name = (await target.locator("span").first().innerText()).trim()
  if (!name) throw new Error("Failed to resolve model name from list item")
  await target.click()

  await expect(dialog).toHaveCount(0)
  await expect(trigger).toContainText(name)
})
