import { test, expect } from "./fixtures"
import { promptSelector } from "./utils"

test("project search stays centered, local, and available from the composer", async ({ page, gotoSession }) => {
  await gotoSession()

  const trigger = page.getByRole("button", { name: "Search this project", exact: true })
  await trigger.click()

  const dialog = page.getByRole("dialog", { name: "Command palette" })
  const search = dialog.getByRole("combobox", { name: "Search this project" })
  await expect(dialog).toBeVisible()
  await expect(search).toBeFocused()
  await expect(dialog.getByRole("option", { name: /Open project files/ })).toBeVisible()
  await expect(dialog.getByRole("option", { name: /Open settings/ })).toBeVisible()
  await expect(dialog.getByRole("group", { name: "Projects" })).toHaveCount(0)
  await expect(dialog.locator('[role="option"][aria-selected="true"]')).toHaveCount(1)

  const box = await dialog.boundingBox()
  const viewport = page.viewportSize()
  expect(box).toBeTruthy()
  expect(viewport).toBeTruthy()
  // Account for scrollbar and subpixel differences in the packaged browser.
  // The old right-anchored panel was hundreds of pixels off center.
  expect(Math.abs((box?.x ?? 0) + (box?.width ?? 0) / 2 - (viewport?.width ?? 0) / 2)).toBeLessThan(12)
  expect(box?.y ?? -1).toBeGreaterThanOrEqual(0)
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual((viewport?.height ?? 0) + 1)

  const layout = await dialog.evaluate((node) => ({
    clientWidth: node.clientWidth,
    scrollWidth: node.scrollWidth,
  }))
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1)
  await expect(dialog.locator(".command-palette__results-shell")).toHaveCSS("overflow-y", "auto")

  await page.keyboard.press("Escape")
  await expect(search).toHaveCount(0)
  await expect(trigger).toBeFocused()

  const composer = page.locator(promptSelector)
  await composer.click()
  await page.keyboard.press("ControlOrMeta+K")
  await expect(dialog).toBeVisible()
  await expect(search).toBeFocused()

  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
  await expect(composer).toBeFocused()

  await page.keyboard.press("ControlOrMeta+K")
  await search.fill("settings")
  await expect(dialog.getByRole("option", { name: /Open settings/ })).toBeVisible()
  await page.keyboard.press("Enter")

  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Close", exact: true })).toBeVisible()
})
