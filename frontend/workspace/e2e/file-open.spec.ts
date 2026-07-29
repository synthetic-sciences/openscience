import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test, expect } from "./fixtures"

test("can open a file tab from the Files pane", async ({ page, gotoSession }) => {
  await gotoSession()

  await page.getByRole("tab", { name: "Files", exact: true }).click()
  await page.getByPlaceholder("filter this folder…").fill("package.json")

  const fileItem = page.getByRole("button", { name: /^package\.json\b/ }).first()
  await expect(fileItem).toBeVisible()
  await fileItem.click()

  const tab = page.locator('[role="tab"][title="package.json"]')
  await expect(tab).toBeVisible()
  await expect(tab).toHaveAttribute("aria-selected", "true")

  const view = page.locator('[data-component="file-view"]')
  await expect(view).toBeVisible()
  await expect(view).toContainText("@synsci/monorepo")
  await expect(page.getByRole("button", { name: "show panel", exact: true })).toBeVisible()
  await expect(view.getByRole("button", { name: "Refresh", exact: true })).toHaveCount(0)
  await expect(view.getByTitle("close", { exact: true })).toHaveCount(0)
  await expect(tab.getByRole("button", { name: "close tab" })).toBeVisible()

  await page.getByRole("button", { name: "Atlas", exact: true }).click()
  const pane = page.locator(".session-right-pane")
  await expect(pane.getByRole("tab", { name: "Atlas", exact: true })).toHaveAttribute("aria-selected", "true")
  await expect(page.locator('[data-component="artifact-inspector"]')).toHaveCount(0)
})

test("can edit, reset, save, and close a text file", async ({ page, gotoSession }) => {
  const directory = mkdtempSync(path.join(tmpdir(), "openscience-file-e2e-"))
  const filename = "editable.txt"
  const filepath = path.join(directory, filename)
  writeFileSync(filepath, "original\n")

  try {
    await gotoSession()
    await page.getByRole("tab", { name: "Files", exact: true }).click()

    const location = page.getByPlaceholder("/absolute/path")
    await location.fill(directory)
    await location.press("Enter")
    await page.getByPlaceholder("filter this folder…").fill(filename)
    await page.getByRole("button", { name: new RegExp(`^${filename}\\b`) }).click()

    const tab = page.locator(`[role="tab"][title="${filename}"]`)
    await expect(tab).toHaveAttribute("aria-selected", "true")
    await page.getByTitle("edit source", { exact: true }).click()

    const editor = page.locator("textarea:visible").last()
    await expect(editor).toHaveValue("original\n")
    await editor.fill("discarded\n")
    await page.getByRole("button", { name: "reset", exact: true }).click()
    await expect(editor).toHaveValue("original\n")

    await editor.fill("saved\n")
    await page.getByRole("button", { name: "save", exact: true }).click()
    await expect.poll(() => readFileSync(filepath, "utf8")).toBe("saved\n")
    await expect(page.getByRole("button", { name: "save", exact: true })).toHaveCount(0)

    await tab.getByRole("button", { name: "close tab" }).click()
    await expect(tab).toHaveCount(0)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("opens ordinary Markdown as a focused document", async ({ page, gotoSession }) => {
  const directory = mkdtempSync(path.join(tmpdir(), "openscience-markdown-e2e-"))
  const filename = "notes.md"
  const filepath = path.join(directory, filename)
  writeFileSync(filepath, "# Notes\n\nA focused research note.\n")

  try {
    await gotoSession()
    await page.getByRole("tab", { name: "Files", exact: true }).click()

    const location = page.getByPlaceholder("/absolute/path")
    await location.fill(directory)
    await location.press("Enter")
    await page.getByPlaceholder("filter this folder…").fill(filename)
    await page.getByRole("button", { name: new RegExp(`^${filename}\\b`) }).click()

    const view = page.locator('[data-component="file-view"]')
    await expect(view.getByRole("heading", { name: "Notes", exact: true })).toBeVisible()
    await expect(view.locator('[data-component="manuscript-workbench"]')).toHaveCount(0)
    await expect(view.getByRole("button", { name: "Citations", exact: true })).toHaveCount(0)
    await expect(view.getByRole("button", { name: "Figures", exact: true })).toHaveCount(0)
    await expect(view.getByRole("button", { name: "Review", exact: true })).toHaveCount(0)
    await expect(view.getByRole("button", { name: "Publish", exact: true })).toHaveCount(0)

    await view.getByRole("button", { name: "Source", exact: true }).click()
    const editor = view.getByLabel("File source")
    await expect(editor).toHaveValue("# Notes\n\nA focused research note.\n")
    await editor.fill("# Notes\n\nA calmer research note.\n")
    await view.getByRole("button", { name: "save", exact: true }).click()
    await expect.poll(() => readFileSync(filepath, "utf8")).toBe("# Notes\n\nA calmer research note.\n")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
