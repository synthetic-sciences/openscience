import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test, expect } from "./fixtures"
import { openConnectedFile } from "./utils"

test("opens, edits, and saves a Jupyter notebook as source", async ({ page, sdk, openSession }) => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "openscience-notebook-e2e-")))
  const filename = "analysis.ipynb"
  const filepath = path.join(directory, filename)
  const source = {
    cells: [
      { cell_type: "markdown", id: "intro", metadata: {}, source: ["# Experiment\n", "Persistent kernel"] },
      {
        cell_type: "code",
        id: "setup",
        metadata: {},
        source: ["value = 41"],
        execution_count: null,
        outputs: [],
      },
      {
        cell_type: "code",
        id: "result",
        metadata: {},
        source: ["value + 1"],
        execution_count: null,
        outputs: [],
      },
    ],
    metadata: { kernelspec: { display_name: "Python 3", language: "python", name: "python3" } },
    nbformat: 4,
    nbformat_minor: 5,
  }
  writeFileSync(filepath, JSON.stringify(source, null, 2))

  try {
    const sessionID = await openSession()
    await sdk.session.filesystem.grant({ sessionID, path: directory, access: "write", scope: "session" })
    await openConnectedFile(page, directory, filename)

    const view = page.locator('[data-component="file-view"]:visible')
    await expect(view).toContainText("IPYNB source")
    await expect(view.getByRole("tab", { name: "Preview", exact: true })).toBeVisible()
    await expect(view.getByRole("tab", { name: "Edit", exact: true })).toBeVisible()
    await expect(view.getByText('"nbformat": 4,', { exact: true })).toBeVisible()

    await view.getByRole("tab", { name: "Edit", exact: true }).click()
    const editor = view.getByRole("textbox", { name: `${filename} source`, exact: true })
    await expect(editor).toContainText('"value + 1"')
    source.cells[2].source = ["value + 2"]
    await editor.fill(JSON.stringify(source, null, 2))
    await view.getByRole("button", { name: "Save changes", exact: true }).click()

    await expect.poll(() => JSON.parse(readFileSync(filepath, "utf8")).cells[2].source).toEqual(["value + 2"])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
