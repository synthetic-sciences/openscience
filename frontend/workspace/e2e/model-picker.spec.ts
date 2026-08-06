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

test("effort back-navigation stays compact and Manage models opens Customize", async ({ page, gotoSession }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await gotoSession()

  const trigger = page.locator(modelTriggerSelector)
  const picker = page.locator(modelPopoverSelector)
  await trigger.click()
  await picker.locator('[data-model-menu-row="effort"]').click()
  await picker.locator('[data-model-option="effort"][data-model-option-id="high"]').click()

  await expect(picker).toHaveAttribute("data-model-settings-view", "root")
  await expect(picker.getByText("Quick models", { exact: true })).toBeVisible()
  expect(await picker.locator("[data-model-quick]").count()).toBeLessThanOrEqual(4)
  await expect.poll(() => picker.evaluate((element) => element.scrollTop)).toBe(0)

  await picker.locator('[data-model-menu-row="model"]').click()
  await expect(picker).toHaveAttribute("data-model-settings-view", "models")
  const manage = picker.getByRole("button", { name: "Manage models", exact: true })
  await expect(manage).toBeVisible()

  const layout = await picker.evaluate((element) => {
    const footer = element.querySelector<HTMLElement>(".model-settings-manage")
    const catalog = element.querySelector<HTMLElement>(".model-settings-catalog")
    const frame = element.getBoundingClientRect()
    const bounds = footer?.getBoundingClientRect()
    return {
      outerOverflow: element.scrollHeight - element.clientHeight,
      footerVisible: Boolean(bounds && bounds.top >= frame.top && bounds.bottom <= frame.bottom),
      catalogScrolls: Boolean(catalog && catalog.scrollHeight >= catalog.clientHeight),
    }
  })
  expect(layout.outerOverflow).toBeLessThanOrEqual(1)
  expect(layout.footerVisible).toBe(true)
  expect(layout.catalogScrolls).toBe(true)

  await manage.click()
  await expect(picker).toBeHidden()
  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()
  await expect(dialog.locator("header").getByText("Models", { exact: true })).toBeVisible()
  await expect(dialog.getByRole("heading", { name: "Composer models", exact: true })).toBeVisible()
})
