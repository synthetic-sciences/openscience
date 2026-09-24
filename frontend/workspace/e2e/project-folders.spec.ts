import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { test, expect } from "./fixtures"
import { createSdk, fileTab, openFileRow, openSettings, promptSelector } from "./utils"

test("project folders work before a conversation and settings change real access", async ({ page }, info) => {
  test.setTimeout(120_000)
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "openscience-folders-e2e-")))
  const primary = path.join(root, "Delphi")
  const extra = path.join(root, "Reference data")
  await mkdir(primary)
  await mkdir(extra)
  await writeFile(path.join(primary, "notes.txt"), "Existing project notes\n")
  await writeFile(path.join(extra, "reference.csv"), "value\n42\n")
  const project = (
    await createSdk().global.project.create({
      name: "Delphi folder regression",
      sources: [{ path: primary, access: "write" }],
    })
  ).data!
  const sdk = createSdk(project.worktree)
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  // Exercise the browser picker without opening an OS dialog on the test host.
  await page.route("**/api/resolve-folder/dialog?*", (route) =>
    route.fulfill({ status: 501, contentType: "application/json", body: JSON.stringify({ unsupported: true }) }),
  )
  try {
    await page.goto(`/${project.id}/session/new`)
    await expect(page.locator(promptSelector)).toBeVisible()
    await expect(page.getByLabel("Working in Delphi", { exact: true })).toBeVisible()
    await page.getByRole("button", { name: "Open project files", exact: true }).click()
    const files = page.getByRole("region", { name: "Files", exact: true })
    await expect(files.locator('[data-workspace-source="connected"]').filter({ hasText: "Delphi" })).toHaveAttribute(
      "aria-selected",
      "true",
    )
    await expect(files.getByRole("button", { name: "Open file notes.txt", exact: true })).toBeVisible()
    await page.screenshot({ path: info.outputPath("project-folder-before-first-message.png") })
    await openFileRow(page, "notes.txt")
    const view = page.locator('[data-component="file-view"]:visible')
    await expect(view).toContainText("Existing project notes")
    await view.getByRole("tab", { name: "Edit", exact: true }).click()
    const editor = view.getByRole("textbox", { name: "notes.txt source", exact: true })
    await editor.press("ControlOrMeta+A")
    await editor.pressSequentially("Saved in Delphi")
    await view.getByRole("button", { name: "Save changes", exact: true }).click()
    await expect.poll(() => readFile(path.join(primary, "notes.txt"), "utf8")).toBe("Saved in Delphi")
    expect((await sdk.session.list()).data).toHaveLength(0)

    await page.reload()
    await expect(page.locator(promptSelector)).toBeVisible()
    await expect(view).toContainText("Saved in Delphi")
    await view.getByRole("tab", { name: "Edit", exact: true }).click()
    await editor.press("ControlOrMeta+A")
    await editor.pressSequentially("Draft preserved through access changes")
    const settings = await openSettings(page)
    await settings.getByRole("button", { name: "Workspaces", exact: true }).click()
    await expect(settings.getByLabel("Project workspace", { exact: true })).toHaveValue(project.id)
    await expect(settings.getByText(primary, { exact: true })).toBeVisible()
    await settings.getByRole("button", { name: "Browse…", exact: true }).click()
    await expect(page.locator(".folder-picker-dialog")).toBeVisible()
    const picker = page.getByRole("dialog", { name: "Connect a folder", exact: true })
    await picker.getByLabel("Go to path", { exact: true }).fill(extra)
    await picker.getByRole("button", { name: "Go", exact: true }).click()
    await expect(picker.locator(".folder-picker__current-path")).toHaveAttribute("title", extra)
    await picker.getByRole("button", { name: "Use this folder", exact: true }).click()
    await expect(page.getByRole("dialog", { name: "Connect a folder", includeHidden: true })).toHaveCount(0)
    await expect(settings.getByLabel("Folder path", { exact: true })).toHaveValue(extra)
    await settings.getByLabel("New folder access", { exact: true }).selectOption("read")
    await settings.getByRole("button", { name: "Connect folder", exact: true }).click()
    await expect(settings.getByLabel(`Access to ${extra}`, { exact: true })).toHaveValue("read")
    await expect
      .poll(
        async () => (await sdk.project.filesystem.list()).data?.grants.filter((grant) => !grant.time.revoked).length,
      )
      .toBe(2)
    await settings.getByLabel(`Access to ${primary}`, { exact: true }).selectOption("read")
    await expect(settings.getByLabel(`Access to ${primary}`, { exact: true })).toBeEnabled()
    await expect
      .poll(async () => (await sdk.file.read({ path: path.join(primary, "notes.txt") })).data?.writable)
      .toBe(false)
    await page.screenshot({ path: info.outputPath("workspace-folder-settings.png") })
    await page.setViewportSize({ width: 960, height: 760 })
    await expect(settings.locator(".workspace-folders")).toBeVisible()
    expect(await settings.locator(".workspace-folders").evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(
      true,
    )
    await page.screenshot({ path: info.outputPath("workspace-folder-settings-narrow.png") })
    await page.setViewportSize({ width: 1280, height: 720 })
    await settings.getByRole("button", { name: "Close", exact: true }).click()
    await expect(page.getByRole("dialog", { name: "Settings", includeHidden: true })).toHaveCount(0)
    await expect(view.getByRole("tab", { name: "Edit", exact: true })).toHaveCount(0)
    expect((await sdk.session.list()).data).toHaveLength(0)

    const reopened = await openSettings(page)
    await reopened.getByRole("button", { name: "Workspaces", exact: true }).click()
    await reopened.getByLabel(`Access to ${primary}`, { exact: true }).selectOption("write")
    await reopened.getByLabel("Default working folder", { exact: true }).selectOption(primary)
    await expect.poll(async () => (await sdk.project.filesystem.list()).data?.workingRoot).toBe(primary)
    await reopened.getByRole("button", { name: `Disconnect ${extra}`, exact: true }).click()
    await page.getByRole("button", { name: "Disconnect folder", exact: true }).click()
    await expect(page.getByRole("alertdialog", { includeHidden: true })).toHaveCount(0)
    await expect(reopened.getByLabel(`Access to ${extra}`, { exact: true })).toHaveCount(0)
    await reopened.getByRole("button", { name: "Close", exact: true }).click()
    await expect(page.getByRole("dialog", { name: "Settings", includeHidden: true })).toHaveCount(0)
    await expect(view.getByRole("tab", { name: "Edit", exact: true })).toBeVisible()
    await view.getByRole("tab", { name: "Edit", exact: true }).click()
    await expect(editor).toContainText("Draft preserved through access changes")
    expect(await readFile(path.join(primary, "notes.txt"), "utf8")).toBe("Saved in Delphi")
    await expect(fileTab(page, "notes.txt")).toHaveAttribute("aria-selected", "true")
    expect(await readFile(path.join(extra, "reference.csv"), "utf8")).toBe("value\n42\n")
    expect(errors).toEqual([])
    expect((await sdk.session.list()).data).toHaveLength(0)
  } finally {
    for (const grant of (await sdk.project.filesystem.list()).data?.grants ?? []) {
      if (!grant.time.revoked) await sdk.project.filesystem.revoke({ grantID: grant.id })
    }
    await rm(root, { recursive: true, force: true })
  }
})
