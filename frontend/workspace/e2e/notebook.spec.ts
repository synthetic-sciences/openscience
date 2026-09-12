import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { test, expect } from "./fixtures"
import { openConnectedFile, trustProject } from "./utils"

test("previews, runs, edits, and saves a local Jupyter notebook", async ({
  page,
  sdk,
  openSession,
  directory: project,
}) => {
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
        outputs: [{ output_type: "stream", name: "stdout", text: ["Saved setup output\n"] }],
      },
      {
        cell_type: "code",
        id: "result",
        metadata: {},
        source: ["value + 1"],
        execution_count: null,
        outputs: [
          {
            output_type: "display_data",
            data: {
              "image/svg+xml":
                '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="green"/></svg>',
            },
          },
          {
            output_type: "display_data",
            data: {
              "text/html":
                "<table><tr><td>Saved table</td></tr></table><script>window.notebookExecuted = true</script>",
            },
          },
        ],
      },
    ],
    metadata: { kernelspec: { display_name: "Python 3", language: "python", name: "python3" } },
    nbformat: 4,
    nbformat_minor: 5,
  }
  writeFileSync(filepath, JSON.stringify(source, null, 2))

  try {
    const sessionID = await openSession()
    await trustProject(sdk, project)
    await sdk.session.filesystem.grant({ sessionID, path: directory, access: "write", scope: "session" })
    await openConnectedFile(page, directory, filename)

    const view = page.locator('[data-component="file-view"]:visible')
    await expect(view).toContainText("Jupyter notebook")
    await expect(view.getByRole("tab", { name: "Preview", exact: true })).toBeVisible()
    await expect(view.getByRole("tab", { name: "Edit", exact: true })).toBeVisible()
    await expect(view.getByRole("heading", { name: "Experiment", exact: true })).toBeVisible()
    await expect(view).toContainText("Saved setup output")
    await expect(view.getByText('"nbformat": 4,', { exact: true })).toHaveCount(0)
    await expect
      .poll(() =>
        view.getByRole("img", { name: "Cell 3 output" }).evaluate((img: HTMLImageElement) => img.naturalWidth),
      )
      .toBe(80)
    await expect(view.frameLocator("iframe").locator("td")).toHaveText("Saved table")
    expect(
      await view
        .frameLocator("iframe")
        .locator("body")
        .evaluate(
          (body) => (body.ownerDocument.defaultView as Window & { notebookExecuted?: boolean }).notebookExecuted,
        ),
    ).toBeUndefined()
    await view.getByRole("button", { name: "Run cell 2 in Python", exact: true }).click()
    await expect(view.getByRole("region", { name: "Cell 2", exact: true })).toContainText("Completed without output", {
      timeout: 30000,
    })
    await view.getByRole("button", { name: "Run cell 3 in Python", exact: true }).click()
    await expect(view.locator('[aria-label="Cell 3"] .atlas-file-notebook-output')).toContainText("42", {
      timeout: 30000,
    })
    expect(JSON.parse(readFileSync(filepath, "utf8"))).toEqual(source)
    await page.screenshot({ path: test.info().outputPath("notebook-preview.png") })

    await view.getByRole("tab", { name: "Edit", exact: true }).click()
    const editor = view.getByRole("textbox", { name: `${filename} source`, exact: true })
    await expect(editor).toContainText('"value + 1"')
    source.cells[2].source = ["value + 2"]
    await editor.fill(JSON.stringify(source, null, 2))
    await view.getByRole("button", { name: "Save changes", exact: true }).click()

    await expect.poll(() => JSON.parse(readFileSync(filepath, "utf8")).cells[2].source).toEqual(["value + 2"])
  } finally {
    await page.goto("about:blank")
    rmSync(directory, { recursive: true, force: true })
  }
})

for (const extension of ["Rmd", "qmd"]) {
  test(`renders local ${extension} prose, R chunks, and relative images`, async ({ page, sdk, openSession }) => {
    const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "openscience-document-e2e-")))
    const filename = `analysis.${extension}`
    const source =
      "---\ntitle: Sample report\n---\n\n# Results\n\nA **rendered** analysis.\n\n![Measured plot](plot.svg)\n\n```{r summary}\nmean(c(1, 2, 3))\n```\n"
    writeFileSync(path.join(directory, filename), source)
    writeFileSync(
      path.join(directory, "plot.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80"><rect width="160" height="80" fill="#4b8a72"/></svg>',
    )
    try {
      const sessionID = await openSession()
      await sdk.session.filesystem.grant({ sessionID, path: directory, access: "write", scope: "session" })
      await openConnectedFile(page, directory, filename)
      const view = page.locator('[data-component="file-view"]:visible')
      await expect(view.getByRole("heading", { name: "Results", exact: true })).toBeVisible()
      await expect(view.locator("strong")).toHaveText("rendered")
      await expect(view.getByRole("button", { name: "Run cell 3 in R", exact: true })).toBeEnabled()
      await expect
        .poll(() =>
          view.getByRole("img", { name: "Measured plot" }).evaluate((img: HTMLImageElement) => img.naturalWidth),
        )
        .toBe(160)
      await view.getByRole("tab", { name: "Edit", exact: true }).click()
      await expect(view.getByRole("textbox", { name: `${filename} source`, exact: true })).toContainText(
        "mean(c(1, 2, 3))",
      )
      await view.getByRole("tab", { name: "Preview", exact: true }).click()
      await expect(view.getByRole("heading", { name: "Results", exact: true })).toBeVisible()
      expect(readFileSync(path.join(directory, filename), "utf8")).toBe(source)
      await page.screenshot({ path: test.info().outputPath(`${extension}-preview.png`) })
    } finally {
      await page.goto("about:blank")
      rmSync(directory, { recursive: true, force: true })
    }
  })
}

test("runs R document chunks in the real local R kernel", async ({ page, sdk, openSession, directory: project }) => {
  test.skip(spawnSync("Rscript", ["--version"]).status !== 0, "Requires a local R interpreter")
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "openscience-r-document-e2e-")))
  writeFileSync(
    path.join(directory, "analysis.Rmd"),
    "# R analysis\n\n```{r}\nvalues <- c(1, 2, 3)\n```\n\n```{r}\nmean(values)\n```\n",
  )
  try {
    const sessionID = await openSession()
    await trustProject(sdk, project)
    await sdk.session.filesystem.grant({ sessionID, path: directory, access: "write", scope: "session" })
    await openConnectedFile(page, directory, "analysis.Rmd")
    const view = page.locator('[data-component="file-view"]:visible')
    await view.getByRole("button", { name: "Run cell 2 in R", exact: true }).click()
    await expect(view.locator('[aria-label="Cell 2"]')).toContainText("Completed without output", { timeout: 30000 })
    await view.getByRole("button", { name: "Run cell 3 in R", exact: true }).click()
    await expect(view.locator('[aria-label="Cell 3"] .atlas-file-notebook-output')).toContainText("[1] 2", {
      timeout: 30000,
    })
  } finally {
    await page.goto("about:blank")
    rmSync(directory, { recursive: true, force: true })
  }
})
