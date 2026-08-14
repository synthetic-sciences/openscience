import { test, expect } from "./fixtures"
import { modelPopoverSelector, modelTriggerSelector } from "./utils"

async function openModelPicker(page: import("@playwright/test").Page) {
  await page.locator(modelTriggerSelector).click()
  const picker = page.locator(modelPopoverSelector)
  const search = picker.getByLabel("Find a model or provider")
  if (!(await search.isVisible().catch(() => false))) await picker.locator('[data-model-menu-row="model"]').click()
  await expect(search).toBeVisible()
  return picker
}

test("hiding a model removes it from the model picker", async ({ page, gotoSession }) => {
  await gotoSession()

  const picker = await openModelPicker(page)

  const target = picker.locator('[data-model-catalog-item][aria-checked="false"]').first()
  await expect(target).toBeVisible()

  const name = (await target.locator(".model-settings-model > strong").textContent())?.trim() ?? ""
  if (!name) throw new Error("Failed to resolve model name from list item")

  await picker.getByRole("button", { name: "manage models" }).first().click()

  const manage = page.getByRole("dialog")
  await expect(manage.getByRole("heading", { name: "Models", exact: true })).toBeVisible()
  const search = manage.getByLabel("Filter models")
  await expect(search).toBeVisible()
  await search.fill(name)

  const input = manage.getByRole("switch", { name: `Hide ${name}`, exact: true })
  await expect(input).toBeChecked()
  await input.locator("..").locator('[data-slot="switch-control"]').click()
  await expect(manage.getByRole("switch", { name: `Show ${name}`, exact: true })).not.toBeChecked()

  await manage.getByRole("button", { name: "Close" }).click()
  await expect(manage).toHaveCount(0)

  const pickerAgain = await openModelPicker(page)
  await expect(
    pickerAgain.locator("[data-model-catalog-item]").filter({ has: pickerAgain.getByText(name, { exact: true }) }),
  ).toHaveCount(0)

  await page.keyboard.press("Escape")
  await expect(pickerAgain).toBeHidden()
})
