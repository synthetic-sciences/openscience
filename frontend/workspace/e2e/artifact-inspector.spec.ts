import { test, expect } from "./fixtures"
import { openWorkspaceFile } from "./utils"

test("right pane stays inline at desktop widths and overlays below the breakpoint", async ({ page, openSession }) => {
  await page.setViewportSize({ width: 1280, height: 760 })
  await openSession()
  await openWorkspaceFile(page, "frontend/workspace/e2e/science/water.xyz")

  const pane = page.locator(".session-right-pane")
  const conversation = page.locator('[data-component="conversation-center"]')
  await expect(pane).toHaveAttribute("data-overlay", "false")
  const [paneBox, centerBox] = await Promise.all([pane.boundingBox(), conversation.boundingBox()])
  expect(paneBox?.width).toBeGreaterThanOrEqual(360)
  expect(centerBox?.width).toBeGreaterThan(200)
  expect(paneBox?.x).toBeGreaterThan(centerBox?.x ?? 0)

  await page.setViewportSize({ width: 820, height: 760 })
  await expect(pane).toHaveAttribute("data-overlay", "true")
  await expect(page.locator(".session-right-pane-backdrop")).toHaveCount(1)
  await page.keyboard.press("Escape")
  await expect(page.locator(".right-pane-gate")).toHaveAttribute("data-open", "false")
  await expect(pane).toBeHidden()
  await expect(page.locator(".session-right-pane-backdrop")).toHaveCount(0)
})

test("normal file views do not expose the retired artifact-details surface", async ({ page, openSession }) => {
  await openSession()
  await openWorkspaceFile(page, "frontend/workspace/e2e/science/water.xyz")

  await expect(page.locator('[data-component="file-view"]:visible')).toBeVisible()
  await expect(page.getByRole("button", { name: "Open file details", exact: true })).toHaveCount(0)
  await expect(page.locator('[data-component="artifact-inspector"]')).toHaveCount(0)
})
