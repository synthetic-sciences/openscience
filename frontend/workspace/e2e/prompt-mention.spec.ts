import { test, expect } from "./fixtures"
import { promptSelector } from "./utils"

test("smoke @mention inserts file pill token", async ({ page, gotoSession }) => {
  await gotoSession()

  await page.locator(promptSelector).click()
  const file = "package.json"

  await page.keyboard.type(`@${file}`)

  const suggestion = page.getByText("/package.json", { exact: true }).locator("xpath=ancestor::button[1]")
  await expect(suggestion).toBeVisible()
  await suggestion.click()

  const pill = page.locator(`${promptSelector} [data-type="file"]`).first()
  await expect(pill).toBeVisible()
  await expect(pill).toHaveAttribute("data-path", file)

  await page.keyboard.type(" ok")
  await expect(page.locator(promptSelector)).toContainText("ok")
})
