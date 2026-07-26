import path from "node:path"
import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

async function openFile(page: Page, directory: string, relativePath: string) {
  await page.getByRole("tab", { name: "Files", exact: true }).click()

  const folder = path.join(directory, path.dirname(relativePath))
  const filename = path.basename(relativePath)
  const location = page.getByPlaceholder("/absolute/path")
  await location.fill(folder)
  await location.press("Enter")

  await page.getByPlaceholder("filter this folder…").fill(filename)
  const file = page.getByRole("button", { name: new RegExp(`^${escapeRegex(filename)}\\b`) }).first()
  await expect(file).toBeVisible()
  await file.click()
  await expect(page.locator(`[role="tab"][title="${filename}"]`)).toHaveAttribute("aria-selected", "true")
}

test("markdown files render and can toggle their raw source", async ({ page, directory, gotoSession }) => {
  await gotoSession()
  await openFile(page, directory, "README.md")

  await expect(page.locator("[data-component=markdown].atlas-md")).toBeVisible()
  await expect(page.getByText("The open-source AI workbench for scientific research", { exact: true })).toBeVisible()
  await page.getByTitle("raw source", { exact: true }).click()
  await expect(page.getByTitle("rendered view", { exact: true })).toBeVisible()
  await expect(
    page.getByText("### The open-source AI workbench for scientific research", { exact: true }),
  ).toBeVisible()
})

test("image files render their decoded dimensions", async ({ page, directory, gotoSession }) => {
  await gotoSession()
  await openFile(page, directory, "frontend/ui/src/assets/images/social-share.png")

  const image = page.getByRole("img", { name: "social-share.png", exact: true })
  await expect(image).toBeVisible()
  await expect
    .poll(() => image.evaluate((node: HTMLImageElement) => [node.naturalWidth, node.naturalHeight, node.src]))
    .toEqual([1280, 721, expect.stringMatching(/^data:image\/png;base64,/)])
})

test("PDF files rasterize their pages without an error", async ({ page, directory, gotoSession }) => {
  await gotoSession()
  await openFile(page, directory, "backend/cli/skills/writing/ml-paper-writing/templates/icml2026/icml_numpapers.pdf")

  const viewer = page.locator('[data-component="science-pdf"]')
  await expect(viewer).toBeVisible()
  await expect(viewer.locator('[data-slot="pdf-header"]')).toContainText("1 page", { timeout: 30_000 })
  const canvas = viewer.locator('[data-slot="pdf-body"] canvas').first()
  await expect(canvas).toBeVisible()
  expect(await canvas.evaluate((node: HTMLCanvasElement) => node.width * node.height)).toBeGreaterThan(0)
  await expect(viewer.locator('[data-slot="pdf-error"]')).toHaveCount(0)
})
