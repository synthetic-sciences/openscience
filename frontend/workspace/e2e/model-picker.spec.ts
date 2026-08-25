import { test, expect } from "./fixtures"
import { modelPopoverSelector, modelRowValue, modelTriggerSelector, setModelEffort } from "./utils"

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

  const name = (await target.locator(".model-settings-model > strong").textContent())?.trim() ?? ""
  if (!name) throw new Error("Failed to resolve model name from list item")
  await target.click()

  await expect(picker).toBeHidden()
  await expect(trigger).toContainText(name)
})

test("effort selection closes cleanly and Manage models opens Customize", async ({ page, gotoSession }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await gotoSession()

  const trigger = page.locator(modelTriggerSelector)
  const picker = page.locator(modelPopoverSelector)
  await setModelEffort(page, "high")
  await expect(modelRowValue(page, "effort")).resolves.toBe("High")

  await trigger.click()
  await expect(picker).toHaveAttribute("data-model-settings-view", "root")
  await expect(picker.getByRole("radiogroup", { name: "Model", exact: true })).toBeVisible()
  const quickCount = await picker.locator("[data-model-quick]").count()
  expect(quickCount).toBeGreaterThan(0)
  expect(quickCount).toBeLessThanOrEqual(10)
  await expect.poll(() => picker.evaluate((element) => element.scrollTop)).toBe(0)

  await picker.locator('[data-model-menu-row="model"]').click()
  await expect(picker).toHaveAttribute("data-model-settings-view", "models")
  const manage = picker.getByRole("button", { name: /^Manage models/ })
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
  const customize = dialog.getByRole("button", { name: "Customize models", exact: true })
  await expect(customize).toBeVisible()
  await expect(dialog.getByLabel("Filter models", { exact: true })).toHaveCount(0)
  await customize.click()
  await expect(dialog.getByLabel("Filter models", { exact: true })).toBeVisible()
})
