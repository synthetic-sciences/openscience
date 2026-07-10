import { test, expect } from "./fixtures"

test("attaches Markdown and text files", async ({ page, gotoSession }) => {
  await gotoSession()

  const input = page.locator('input[type="file"][accept*=".md"]')
  await expect(input).toHaveCount(1)

  await input.setInputFiles({
    name: "research-notes.md",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("# Research notes"),
  })
  await expect(page.getByText("research-notes.md", { exact: true })).toBeVisible()

  await input.setInputFiles({
    name: "observations.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Observation one"),
  })
  await expect(page.getByText("observations.txt", { exact: true })).toBeVisible()
})
