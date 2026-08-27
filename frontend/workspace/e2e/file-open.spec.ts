import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test, expect } from "./fixtures"
import { fileTab, openConnectedFile, openWorkspaceFile } from "./utils"

test("open files become tabs in the right pane", async ({ page, openSession }) => {
  await openSession()

  await openWorkspaceFile(page, "package.json")
  const view = page.locator('[data-component="file-view"]:visible')
  await expect(view).toBeVisible()
  await expect(view).toContainText("@synsci/monorepo")
  await expect(view.getByRole("tab", { name: "Preview", exact: true })).toBeVisible()
  await expect(view.getByRole("tab", { name: "Edit", exact: true })).toBeVisible()

  // Opening a second file adds a tab and activates it.
  await openWorkspaceFile(page, "README.md")
  const tabs = page.getByRole("tablist", { name: "Contextual work tabs", exact: true }).getByRole("tab")
  await expect(tabs).toHaveCount(3)
  await expect(fileTab(page, "package.json")).toHaveAttribute("aria-selected", "false")

  // Clicking an inactive tab activates its file again.
  await fileTab(page, "package.json").click()
  await expect(fileTab(page, "package.json")).toHaveAttribute("aria-selected", "true")
  await expect(view).toContainText("@synsci/monorepo")

  // Switching the pane to another context leaves the conversation center
  // intact and hides the file surface without destroying the tabs.
  await page.getByRole("button", { name: "Open project terminal", exact: true }).click()
  await expect(page.getByRole("region", { name: "Session terminal" })).toBeVisible()
  await expect(view).toBeHidden()

  // File tabs are drag-reorderable; Alt+Arrow drives the same reorder path.
  await page.getByRole("button", { name: "Open project files", exact: true }).click()
  await fileTab(page, "package.json").focus()
  await page.keyboard.press("Alt+ArrowRight")
  await expect(tabs.nth(1)).toHaveAccessibleName("README.md")

  // Inactive tabs reveal their close action on hover, matching the user path.
  await fileTab(page, "README.md").hover()
  await page.getByRole("button", { name: "Close README.md", exact: true }).click()
  await fileTab(page, "package.json").hover()
  await page.getByRole("button", { name: "Close package.json", exact: true }).click()
  await expect(fileTab(page, "README.md")).toHaveCount(0)
  await expect(fileTab(page, "package.json")).toHaveCount(0)
  await expect(page.getByRole("tab", { name: "Files", exact: true })).toHaveAttribute("aria-selected", "true")
})

test("can edit, discard, save, and close a text file", async ({ page, sdk, openSession }) => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "openscience-file-e2e-")))
  const filename = "editable.txt"
  const filepath = path.join(directory, filename)
  writeFileSync(filepath, "original\n")

  try {
    const sessionID = await openSession()
    await sdk.session.filesystem.grant({ sessionID, path: directory, access: "write", scope: "session" })

    const tab = await openConnectedFile(page, directory, filename)
    const view = page.locator('[data-component="file-view"]:visible')
    await view.getByRole("tab", { name: "Edit", exact: true }).click()

    const editor = view.getByRole("textbox", { name: `${filename} source`, exact: true })
    await expect(editor).toHaveText("original")
    await editor.fill("discarded\n")
    await view.getByRole("button", { name: "Discard changes", exact: true }).click()
    await expect(editor).toHaveText("original")

    await editor.fill("saved\n")
    await view.getByRole("button", { name: "Save changes", exact: true }).click()
    await expect.poll(() => readFileSync(filepath, "utf8")).toBe("saved\n")
    await expect(view.getByRole("button", { name: "Save changes", exact: true })).toHaveCount(0)

    await page.getByRole("button", { name: `Close ${filename}`, exact: true }).click()
    await expect(tab).toHaveCount(0)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("opens ordinary Markdown as a focused document", async ({ page, sdk, openSession }) => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "openscience-markdown-e2e-")))
  const filename = "notes.md"
  const filepath = path.join(directory, filename)
  writeFileSync(filepath, "# Notes\n\nA focused research note.\n")

  try {
    const sessionID = await openSession()
    await sdk.session.filesystem.grant({ sessionID, path: directory, access: "write", scope: "session" })
    await openConnectedFile(page, directory, filename)

    const view = page.locator('[data-component="file-view"]:visible')
    await expect(view.getByRole("heading", { name: "Notes", exact: true })).toBeVisible()
    await expect(view.locator('[data-component="manuscript-workbench"]')).toHaveCount(0)
    await expect(view.getByRole("button", { name: "Citations", exact: true })).toHaveCount(0)
    await expect(view.getByRole("button", { name: "Figures", exact: true })).toHaveCount(0)
    await expect(view.getByRole("button", { name: "Review", exact: true })).toHaveCount(0)
    await expect(view.getByRole("button", { name: "Publish", exact: true })).toHaveCount(0)

    await view.getByRole("tab", { name: "Edit", exact: true }).click()
    const editor = view.getByRole("textbox", { name: `${filename} source`, exact: true })
    await expect(editor).toContainText("A focused research note.")
    await editor.fill("# Notes\n\nA calmer research note.\n")
    await view.getByRole("button", { name: "Save changes", exact: true }).click()
    await expect.poll(() => readFileSync(filepath, "utf8")).toBe("# Notes\n\nA calmer research note.\n")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
