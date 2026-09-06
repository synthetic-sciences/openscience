import { test, expect } from "./fixtures"
import { modelPopoverSelector, modelRowValue, modelTriggerSelector, setModelEffort } from "./utils"
import { COMPOSER_MODEL_ROSTER } from "../src/context/model-catalog"

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
  const current = (await trigger.locator(":scope > .truncate").innerText()).trim()
  expect(current).not.toBe("")

  await trigger.click()
  await expect(picker).toHaveAttribute("data-model-settings-view", "root")
  await expect(picker.getByRole("radiogroup", { name: "Model", exact: true })).toBeVisible()
  // An explicitly selected model outside the roster (the isolated Echo model,
  // for example) stays reachable without leaking the full provider catalog.
  const roster: string[] = COMPOSER_MODEL_ROSTER.map((model) => model.label)
  const expected = roster.includes(current) ? roster : [...roster, current]
  await expect(picker.locator("[data-model-quick] .model-settings-model > strong")).toHaveText(expected)
  const selected = picker.locator('[data-model-quick][aria-checked="true"]')
  await expect(selected).toHaveCount(1)
  await expect(selected.locator(".model-settings-model > strong")).toHaveText(current)
  const choices = await picker
    .locator("[data-model-quick][data-model-choice]")
    .evaluateAll((elements) => elements.map((element) => element.getAttribute("data-model-choice")))
  expect(new Set(choices).size).toBe(choices.length)
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
  await expect(dialog.getByRole("heading", { name: "Model preferences", exact: true })).toBeVisible()
  await expect(dialog.getByText("Composer models", { exact: true })).toBeVisible()
  const edit = dialog.locator(".models-preferences-card").getByRole("button", { name: "Edit", exact: true })
  await expect(edit).toBeVisible()
  await expect(dialog.getByLabel("Filter models", { exact: true })).toHaveCount(0)
  await edit.click()
  await expect(dialog.getByLabel("Filter models", { exact: true })).toBeVisible()
})
