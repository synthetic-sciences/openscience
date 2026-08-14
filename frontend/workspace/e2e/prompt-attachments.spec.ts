import { fileURLToPath } from "node:url"
import { expect, test } from "./fixtures"

test("attached research files keep their filename, extension, and size visible", async ({ page, gotoSession }) => {
  await gotoSession()

  await page
    .locator('input[type="file"]')
    .setInputFiles(fileURLToPath(new URL("./science/manuscript.md", import.meta.url)))

  const attachments = page.getByLabel("Attached files")
  await expect(attachments).toBeVisible()
  await expect(attachments.getByText("manuscript.md", { exact: true })).toBeVisible()
  await expect(attachments).toContainText(/Attached · MD · [\d.]+ (?:B|KB)/)
})
