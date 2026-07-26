import { test, expect } from "./fixtures"
import { terminalSelector } from "./utils"

test.describe.configure({ mode: "serial" })

test("terminal mounts and can create another tab", async ({ page, gotoSession }) => {
  await gotoSession()

  const terminalTab = page.getByRole("tab", { name: "terminal", exact: true })
  await terminalTab.click()
  await expect(terminalTab).toHaveAttribute("aria-selected", "true")

  const terminals = page.locator(terminalSelector)
  if ((await terminals.count()) === 0) {
    await page.getByRole("button", { name: "start terminal", exact: true }).click()
  }

  await expect(terminals.first()).toBeVisible()
  await expect(terminals.first().locator("textarea")).toHaveCount(1)
  const before = await terminals.count()

  await page.getByRole("button", { name: "new", exact: true }).click()
  await expect(terminals).toHaveCount(before + 1)
  await expect(terminals.nth(before).locator("textarea")).toHaveCount(1)
})

test("terminal panel can be collapsed and reopened", async ({ page, gotoSession }) => {
  await gotoSession()

  const terminalTab = page.getByRole("tab", { name: "terminal", exact: true })
  await expect(terminalTab).toBeVisible()
  await terminalTab.click()
  await expect(terminalTab).toHaveAttribute("aria-selected", "true")

  await page.getByTitle("hide panel", { exact: true }).click()
  await expect(terminalTab).toHaveCount(0)

  await page.getByRole("button", { name: "terminal", exact: true }).click()
  await expect(terminalTab).toBeVisible()
  await expect(terminalTab).toHaveAttribute("aria-selected", "true")
})
