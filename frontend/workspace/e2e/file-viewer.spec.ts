import { test, expect } from "./fixtures"
test("smoke file viewer renders real file content", async ({ page, gotoSession }) => {
  await gotoSession()

  await page.getByRole("tab", { name: "Files", exact: true }).click()
  await expect(page.getByPlaceholder("/absolute/path")).toBeVisible()
  await expect(page.getByRole("button", { name: /^artifacts$/i })).toHaveCount(0)
  await page.getByPlaceholder("filter this folder…").fill("package.json")

  const fileItem = page.getByRole("button", { name: /^package\.json\b/ }).first()
  await expect(fileItem).toBeVisible()
  await fileItem.click()

  const tab = page.locator('[role="tab"][title="package.json"]')
  await expect(tab).toBeVisible()
  await expect(tab).toHaveAttribute("aria-selected", "true")

  await expect(page.getByText("@synsci/monorepo")).toBeVisible()
})
