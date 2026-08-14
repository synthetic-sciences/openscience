import { test, expect } from "./fixtures"
import { openWorkspaceFile } from "./utils"

const view = (page: import("@playwright/test").Page) => page.locator('[data-component="file-view"]:visible')

test("markdown files render and can toggle their editable source", async ({ page, openSession }) => {
  await openSession()
  await openWorkspaceFile(page, "README.md")

  // A README with a centered hero is intentionally split into two sanitized
  // Markdown regions, so assert the preview container instead of assuming one.
  await expect(view(page).locator(".atlas-file-document")).toBeVisible()
  await expect(
    view(page).getByText("The open-source AI workbench for scientific research", { exact: true }),
  ).toBeVisible()
  await view(page).getByRole("tab", { name: "Edit", exact: true }).click()
  await expect(view(page).getByRole("tab", { name: "Preview", exact: true })).toBeVisible()
  await expect(view(page).getByLabel("File source")).toHaveValue(
    /### The open-source AI workbench for scientific research/,
  )
})

test("image files render their decoded dimensions", async ({ page, openSession }) => {
  await openSession()
  await openWorkspaceFile(page, "frontend/ui/src/assets/images/social-share.png")

  const image = page.getByRole("img", { name: "social-share.png", exact: true })
  await expect(image).toBeVisible()
  await expect
    .poll(() => image.evaluate((node: HTMLImageElement) => [node.naturalWidth, node.naturalHeight, node.src]))
    .toEqual([1280, 721, expect.stringMatching(/^data:image\/png;base64,/)])
})

test("PDF files rasterize their pages without an error", async ({ page, openSession }) => {
  await openSession()
  await openWorkspaceFile(page, "backend/cli/skills/writing/ml-paper-writing/templates/icml2026/icml_numpapers.pdf")

  const viewer = page.locator('[data-component="science-pdf"]')
  await expect(viewer).toBeVisible()
  await expect(viewer.locator('[data-slot="pdf-header"]')).toContainText("Page 1 of 1", { timeout: 30_000 })
  const canvas = viewer.locator('[data-slot="pdf-body"] canvas').first()
  await expect(canvas).toBeVisible()
  expect(await canvas.evaluate((node: HTMLCanvasElement) => node.width * node.height)).toBeGreaterThan(0)
  await expect(viewer.locator('[data-slot="pdf-error"]')).toHaveCount(0)
})

test("XYZ files open as interactive 3D chemistry with source access", async ({ page, openSession }) => {
  await openSession()
  await openWorkspaceFile(page, "frontend/workspace/e2e/science/water.xyz")

  const artifact = page.locator('[data-component="science-artifact"][data-kind="chem-3d"]')
  await expect(artifact).toBeVisible()
  await expect(artifact.locator('[data-component="mol-structure"]')).toBeVisible()
  const summary = artifact.locator('[data-component="molecular-summary"]')
  await expect(summary).toContainText("3 atoms")
  await expect(summary).toContainText("H 2")
  await expect(summary).toContainText("O 1")
  await expect(view(page).getByRole("tab", { name: "Edit", exact: true })).toBeVisible()
  await expect(view(page).getByRole("button", { name: "Copy contents", exact: true })).toBeVisible()
  await expect(view(page).getByRole("button", { name: "Refresh", exact: true })).toHaveCount(0)

  const structure = artifact.locator('[data-component="mol-structure"]')
  await expect(structure).toHaveAttribute("data-status", "ready", { timeout: 30_000 })
  const controls = artifact.locator('[data-component="molecular-controls"]')
  await expect(controls.getByLabel("Representation")).toHaveValue("auto")
  await controls.getByLabel("Representation").selectOption("atomic-detail")
  await expect(controls).toHaveAttribute("data-preset", "atomic-detail")
  await controls.getByLabel("Selection granularity").selectOption("residue")
  await expect(controls).toHaveAttribute("data-granularity", "residue")
  await expect(controls.getByRole("button", { name: "Measure distance", exact: true })).toBeDisabled()
  await controls.getByRole("button", { name: "Reset camera", exact: true }).click()
  await controls.getByRole("button", { name: "Light background", exact: true }).click()
  await expect(controls).toHaveAttribute("data-background", "light")

  const download = page.waitForEvent("download")
  await controls.getByRole("button", { name: "Export PNG", exact: true }).click()
  await expect((await download).suggestedFilename()).toMatch(/^water-structure\.png$/)

  await view(page).getByRole("tab", { name: "Edit", exact: true }).click()
  await expect(view(page).getByRole("tab", { name: "Preview", exact: true })).toBeVisible()
  await expect(view(page).getByLabel("File source")).toHaveValue(/water/)
})

test("PDB and SDF files select their molecular renderers", async ({ page, openSession }) => {
  await openSession()
  await openWorkspaceFile(page, "frontend/workspace/e2e/science/example.pdb")
  await expect(page.locator('[data-component="science-artifact"][data-kind="protein-structure"]')).toBeVisible()

  await openWorkspaceFile(page, "frontend/workspace/e2e/science/ligand.sdf")
  await expect(page.locator('[data-component="science-artifact"][data-kind="chem-3d"]')).toBeVisible()
})

test("aligned FASTA files open in the sequence alignment viewer", async ({ page, openSession }) => {
  await openSession()
  await openWorkspaceFile(page, "frontend/workspace/e2e/science/alignment.fasta")

  const artifact = page.locator('[data-component="science-artifact"][data-kind="msa"]')
  await expect(artifact).toBeVisible()
  await expect(artifact.locator('[data-component="science-msa"]')).toBeVisible()
  await expect(artifact).toContainText("2 seqs")
})
