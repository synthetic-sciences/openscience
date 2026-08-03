import { test, expect } from "./fixtures"
import { openFilesSources } from "./utils"

test("project sources use the host-native folder picker", async ({ page, directory }) => {
  const calls: Array<{ kind: string; title: string; multiple: boolean }> = []
  await page.route("**/api/resolve-folder/dialog", async (route) => {
    const body = route.request().postDataJSON() as { kind: string; title: string; multiple: boolean }
    calls.push(body)
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ paths: [directory] }),
    })
  })

  await page.goto("/")
  await page
    .getByRole("button", { name: /new project/i })
    .first()
    .click()
  const dialog = page.getByRole("dialog", { name: "Create project" })
  await dialog.getByRole("button", { name: /add source folders/i }).click()

  await expect(dialog.getByRole("button", { name: `Remove source folder ${directory}` })).toBeVisible()
  expect(calls).toEqual([{ kind: "folder", title: "Add source folders", multiple: true }])
})

test("source files and folders use the host-native picker", async ({ page, openSession }) => {
  const selected = {
    folder: "/tmp/native-source-folder",
    file: "/tmp/native-source-file.csv",
  }
  const calls: string[] = []
  await page.route("**/api/resolve-folder/dialog", async (route) => {
    const body = route.request().postDataJSON() as { kind: "folder" | "file" }
    calls.push(body.kind)
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ paths: [selected[body.kind]] }),
    })
  })

  await openSession()
  await openFilesSources(page)
  await page.getByRole("button", { name: "Connect another location", exact: true }).click()

  const form = page.getByRole("form", { name: "Connect file or folder access" })
  const input = form.getByPlaceholder("Choose or paste a file or folder path")
  await form.getByRole("button", { name: "Choose folder", exact: true }).click()
  await expect(input).toHaveValue(selected.folder)
  await form.getByRole("button", { name: "Choose file", exact: true }).click()
  await expect(input).toHaveValue(selected.file)
  expect(calls).toEqual(["folder", "file"])
})
