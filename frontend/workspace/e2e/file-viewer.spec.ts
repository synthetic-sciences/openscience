import { test, expect } from "./fixtures"
import { openFilesSources, openWorkspaceFile } from "./utils"

test("smoke file viewer renders real file content", async ({ page, openSession }) => {
  await openSession()

  await openFilesSources(page)
  const files = page.getByRole("region", { name: "Files", exact: true })
  await expect(files.getByRole("searchbox", { name: "Filter this folder", exact: true })).toBeEnabled()
  await expect(files.locator("[data-source-button]")).toHaveAttribute("data-source-kind", "project")
  await files.locator("[data-source-button]").click()
  await expect(files.getByRole("menuitem", { name: "Add folder…", exact: true })).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(files.locator("[data-source-menu]")).toHaveCount(0)

  await openWorkspaceFile(page, "package.json")
  await expect(page.getByText("@synsci/monorepo")).toBeVisible()
})
