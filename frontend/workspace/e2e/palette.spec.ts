import { test, expect } from "./fixtures"
import { promptSelector } from "./utils"

test("project search stays centered, local, and available from the composer", async ({ page, gotoSession }) => {
  await gotoSession()

  await page.getByRole("button", { name: "Search project", exact: true }).click()

  const dialog = page.getByRole("dialog", { name: "command palette" })
  const search = dialog.getByRole("textbox", { name: "Search this project" })
  await expect(dialog).toBeVisible()
  await expect(search).toBeVisible()
  await expect(dialog.getByRole("button", { name: /Open project files/ })).toBeVisible()
  await expect(dialog.getByText("projects", { exact: true })).toHaveCount(0)
  await expect(dialog.getByRole("button", { name: /Settings/ })).toHaveCount(0)

  const box = await dialog.boundingBox()
  const viewport = page.viewportSize()
  expect(box).toBeTruthy()
  expect(viewport).toBeTruthy()
  // Account for scrollbar and subpixel differences in the packaged browser.
  // The old right-anchored panel was hundreds of pixels off center.
  expect(Math.abs((box?.x ?? 0) + (box?.width ?? 0) / 2 - (viewport?.width ?? 0) / 2)).toBeLessThan(12)

  await page.keyboard.press("Escape")
  await expect(search).toHaveCount(0)

  await page.locator(promptSelector).click()
  await page.keyboard.press("ControlOrMeta+K")
  await expect(dialog).toBeVisible()
})
