import { test, expect } from "./fixtures"

test("file browser can descend folders and open a file", async ({ page, gotoSession }) => {
  await gotoSession()

  await page.getByRole("tab", { name: "Files", exact: true }).click()

  const item = (name: string) => page.getByRole("button", { name: new RegExp(`^${name}\\b`) }).first()
  for (const folder of ["frontend", "workspace"]) {
    await expect(item(folder)).toBeVisible()
    await item(folder).click()
  }

  const file = item("package\\.json")
  await expect(file).toBeVisible()
  await file.click()

  await expect(page.locator('[role="tab"][title="package.json"]')).toHaveAttribute("aria-selected", "true")
})
