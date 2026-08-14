import { test, expect } from "./fixtures"
import { openWorkspaceFile } from "./utils"

const MANUSCRIPT = "frontend/workspace/e2e/science/manuscript.md"

test("authors Markdown with live preview, local citations, and local figures", async ({ page, openSession }) => {
  await openSession()
  await openWorkspaceFile(page, MANUSCRIPT)

  const workbench = page.locator('[data-component="manuscript-workbench"]')
  const editor = workbench.getByLabel("Manuscript source")
  const preview = workbench.locator('[data-slot="manuscript-preview"]')
  await expect(workbench).toBeVisible()
  await expect(editor).toBeVisible()
  await expect(preview.getByRole("heading", { name: "Manuscript workbench", exact: true })).toBeVisible()
  await expect(preview).not.toContainText("bibliography: references.bib")

  await editor.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(node.value.length, node.value.length))
  await workbench.getByRole("button", { name: "Citations", exact: true }).click()
  const citations = workbench.locator('[data-component="citation-browser"]')
  await expect(citations.getByText("Reliable Scientific Interfaces", { exact: true })).toBeVisible()
  await citations.getByPlaceholder("Find by author, title, or key…").fill("smith")
  await citations.getByRole("button", { name: "Insert @smith2026", exact: true }).click()
  await expect(editor).toHaveValue(/\[@smith2026\]$/)

  await workbench.getByRole("button", { name: "Figures", exact: true }).click()
  const figures = workbench.locator('[data-component="figure-browser"]')
  await figures.getByPlaceholder("Find a local figure…").fill("manuscript-figure")
  await figures.getByLabel("Figure alt text").fill("Primary endpoint")
  await figures.getByRole("button", { name: "Insert manuscript-figure.svg", exact: true }).click()
  await expect(editor).toHaveValue(/!\[Primary endpoint\]\([^)]*manuscript-figure\.svg\)$/)
  await expect(preview.getByRole("img", { name: "Primary endpoint", exact: true })).toBeVisible()

  await page.getByRole("button", { name: "Discard changes", exact: true }).click()
  await expect(editor).not.toHaveValue(/\[@smith2026\]/)
})

test("exposes exact-byte review and publication export controls", async ({ page, openSession }) => {
  const exports: Array<Record<string, unknown>> = []
  await page.route("**/file/publication", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue()
      return
    }
    exports.push(route.request().postDataJSON() as Record<string, unknown>)
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        path: "exports/manuscript-preview.html",
        format: "html",
        size: 512,
        created_at: new Date().toISOString(),
        engine: "OpenScience Markdown",
        readiness: "draft",
      }),
    })
  })

  await openSession()
  await openWorkspaceFile(page, MANUSCRIPT)
  const workbench = page.locator('[data-component="manuscript-workbench"]')

  // The reviewed export stays locked until the preflight is finalized; the
  // draft export posts the manuscript's exact saved bytes.
  await workbench.getByRole("button", { name: "Publish", exact: true }).click()
  const publish = workbench.locator('[data-component="publication-controls"]')
  await expect(publish.getByText("Preflight export locked", { exact: true })).toBeVisible()
  await publish.getByRole("button", { name: "Export draft HTML", exact: true }).click()
  await expect.poll(() => exports.length).toBe(1)
  // Opened as a session-scoped file, the manuscript exports by its project
  // relative path. Preflight readiness and format are the load-bearing bytes.
  expect(exports[0]).toMatchObject({ format: "html", readiness: "draft" })
  expect(exports[0].path).toMatch(/(^|\/)manuscript\.md$/)
})

test("routes manuscript review into the artifact inspector", async ({ page, openSession }) => {
  await openSession()
  await openWorkspaceFile(page, MANUSCRIPT)
  const workbench = page.locator('[data-component="manuscript-workbench"]')

  // Review stages the preflight into the artifact inspector's Review tab and
  // points the author to Details; opening Details surfaces it there.
  await workbench.getByRole("button", { name: "Review", exact: true }).click()
  await page.getByRole("button", { name: "Open file details", exact: true }).click()
  const inspector = page.locator('[data-component="artifact-inspector"]')
  await expect(inspector.getByRole("tab", { name: "Review", exact: true })).toHaveAttribute("aria-selected", "true")
})
