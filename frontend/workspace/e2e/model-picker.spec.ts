import { test, expect } from "./fixtures"
import { modelPopoverSelector, modelTriggerSelector } from "./utils"

test("smoke model selection updates the composer trigger", async ({ page, gotoSession }) => {
  await gotoSession()

  // The composer model control keeps the full catalog inside the same compact
  // popover instead of opening a second dialog.
  const trigger = page.locator(modelTriggerSelector)
  await expect(trigger).toBeVisible()
  await trigger.click()
  await page.locator(`${modelPopoverSelector} [data-model-menu-row="model"]`).click()

  const picker = page.locator(modelPopoverSelector)
  await expect(picker.getByLabel("Find a model or provider")).toBeVisible()

  const target = picker.locator('[data-model-catalog-item][aria-checked="false"]').first()
  await expect(target).toBeVisible()

  const name = (await target.locator("strong").innerText()).trim()
  if (!name) throw new Error("Failed to resolve model name from list item")
  await target.click()

  await expect(picker).toBeHidden()
  await expect(trigger).toContainText(name)
})
