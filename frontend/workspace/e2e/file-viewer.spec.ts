import { test, expect } from "./fixtures"
import { openFilesSources, openWorkspaceFile } from "./utils"

test("smoke file viewer renders real file content", async ({ page, openSession }) => {
  await openSession()

  await openFilesSources(page)
  await expect(page.getByRole("searchbox", { name: "Search Session files", exact: true })).toBeEnabled()
  await page.locator("[data-source-button]").click()
  await expect(page.getByRole("button", { name: "Add folder…", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Close source menu", exact: true }).click()

  await openWorkspaceFile(page, "package.json")
  await expect(page.getByText("@synsci/monorepo")).toBeVisible()
})
