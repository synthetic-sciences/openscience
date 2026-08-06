import { expect, test } from "./fixtures"

test("keeps the new-session canvas completely blank", async ({ page, gotoSession }) => {
  await gotoSession()

  const launchpad = page.locator('[data-component="research-launchpad"]')
  await expect(launchpad).toBeVisible()
  await expect(launchpad).toHaveAttribute("aria-label", "New research session")
  await expect(launchpad.getByRole("button")).toHaveCount(0)
  await expect(launchpad.getByRole("heading")).toHaveCount(0)
  await expect(launchpad.locator("[data-workflow]")).toHaveCount(0)
  await expect(launchpad.locator("[data-starter]")).toHaveCount(0)
  await expect(page.getByText("Starters", { exact: true })).toHaveCount(0)
})
