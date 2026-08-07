import { test, expect } from "./fixtures"
import { fileTab, openFileRow, openFilesSources } from "./utils"

test("session files source can descend folders and open a file", async ({ page, openSession }) => {
  await openSession()
  await openFilesSources(page)

  for (const folder of ["frontend", "workspace"]) {
    await openFileRow(page, folder)
  }
  await expect(page.locator("[data-file-up]")).toBeVisible()

  await openFileRow(page, "package.json")
  await expect(fileTab(page, "package.json")).toHaveAttribute("aria-selected", "true")
  await expect(page.locator('[data-component="file-view"]')).toContainText("@synsci/workspace")
})
