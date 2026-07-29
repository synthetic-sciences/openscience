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
  await page
    .getByRole("button", { name: new RegExp(`^${escapeRegex(filename)}\\b`) })
    .first()
    .click()
  await expect(page.locator(`[role="tab"][title="${filename}"]`)).toHaveAttribute("aria-selected", "true")
}

test("opened files drive a contextual artifact inspector without stale state", async ({
  page,
  directory,
  gotoSession,
}) => {
  await gotoSession()
  await openFile(page, directory, "frontend/workspace/e2e/science/water.xyz")

  const inspector = page.locator('[data-component="artifact-inspector"]')
  await expect(inspector).toBeVisible()
  await expect(inspector).toHaveAttribute("data-artifact-id", /water\.xyz/)
  await expect(inspector.locator("header strong")).toHaveText("water.xyz")
  await expect(inspector.getByRole("tab")).toHaveCount(7)
  expect((await inspector.boundingBox())?.width).toBeGreaterThanOrEqual(340)
  await expect(inspector.getByText("3 atoms", { exact: true })).toBeVisible()
  await expect(inspector.getByText("PNG export", { exact: true })).toBeVisible()

  const details = inspector.getByRole("tab", { name: "Details", exact: true })
  await details.focus()
  await details.press("ArrowRight")
  await expect(inspector.getByRole("tab", { name: "Code", exact: true })).toHaveAttribute("aria-selected", "true")
  await expect(inspector.locator("pre")).toContainText("water")

  await inspector.getByRole("tab", { name: "Run", exact: true }).click()
  await expect(inspector.getByText("No generating run is recorded", { exact: true })).toBeVisible()

  await openFile(page, directory, "frontend/workspace/e2e/science/alignment.fasta")
  await expect(inspector).toHaveAttribute("data-artifact-id", /alignment\.fasta/)
  await expect(inspector.locator("header strong")).toHaveText("alignment.fasta")
  await expect(inspector.getByRole("tab", { name: "Details", exact: true })).toHaveAttribute("aria-selected", "true")

  await page.getByRole("tab", { name: "Chat", exact: true }).click()
  await expect(inspector).toHaveCount(0)
  await expect(page.locator(".session-right-pane").getByRole("tab", { name: "Atlas", exact: true })).toBeVisible()
})

test("artifact inspector overlays rather than crushing the workbench at narrow desktop widths", async ({
  page,
  directory,
  gotoSession,
}) => {
  await page.setViewportSize({ width: 1024, height: 760 })
  await gotoSession()
  await openFile(page, directory, "frontend/workspace/e2e/science/water.xyz")

  const inspector = page.locator('[data-component="artifact-inspector"]')
  const file = page.locator('[data-component="file-view"]')
  await expect(inspector).toBeVisible()
  await expect(file).toBeVisible()
  const [inspectorBox, fileBox] = await Promise.all([inspector.boundingBox(), file.boundingBox()])
  expect(inspectorBox?.width).toBeGreaterThanOrEqual(280)
  expect(fileBox?.width).toBeGreaterThanOrEqual(520)
  expect(inspectorBox?.x).toBeGreaterThan(fileBox?.x ?? 0)
  const backdrop = page.getByRole("button", { name: "Close inspector overlay", exact: true })
  await expect(backdrop).toBeVisible()
  await backdrop.click({ position: { x: 10, y: 300 } })
  await expect(inspector).toHaveCount(0)
})

test("artifact review threads persist and can be resolved", async ({ page, directory, gotoSession }) => {
  await gotoSession()
  await openFile(page, directory, "frontend/workspace/e2e/science/water.xyz")

  const inspector = page.locator('[data-component="artifact-inspector"]')
  await inspector.getByRole("tab", { name: "Review", exact: true }).click()
  await expect(inspector.getByText("No annotations yet", { exact: true })).toBeVisible()

  await inspector.getByLabel("New annotation").fill("Confirm the O–H bond length before publication.")
  await inspector.getByRole("button", { name: "Add annotation", exact: true }).click()
  const thread = inspector.locator('[data-component="artifact-annotation"]').filter({ hasText: "Confirm the O–H" })
  await expect(thread).toBeVisible()
  await expect(inspector.getByText("1 open", { exact: true })).toBeVisible()
  await expect(thread.getByText("v1", { exact: true })).toBeVisible()
  await expect(thread.getByText("History · 1 revisions", { exact: true })).toBeVisible()

  await thread.getByRole("button", { name: "Resolve", exact: true }).click()
  await expect(thread.getByText("Resolved", { exact: true })).toBeVisible()
  await expect(thread.getByText("v2", { exact: true })).toBeVisible()

  await thread.getByRole("button", { name: "Edit", exact: true }).click()
  await inspector.getByLabel(/Edit annotation/).fill("O–H bond length verified against the source structure.")
  await inspector.getByRole("button", { name: "Save edit", exact: true }).click()
  const updated = inspector
    .locator('[data-component="artifact-annotation"]')
    .filter({ hasText: "O–H bond length verified against the source structure." })
  await expect(
    updated.getByText("O–H bond length verified against the source structure.", { exact: true }),
  ).toBeVisible()
  await expect(updated.getByText("v3", { exact: true })).toBeVisible()
  await expect(updated.getByText("History · 3 revisions", { exact: true })).toBeVisible()

  await openFile(page, directory, "frontend/workspace/e2e/science/alignment.fasta")
  await openFile(page, directory, "frontend/workspace/e2e/science/water.xyz")
  await inspector.getByRole("tab", { name: "Review", exact: true }).click()
  await expect(
    inspector.getByText("O–H bond length verified against the source structure.", { exact: true }),
  ).toBeVisible()
  await expect(inspector.getByText("0 open", { exact: true })).toBeVisible()
})

test("publication review blocks, audits overrides, finalizes, and persists exact manuscript bytes", async ({
  page,
  directory,
  gotoSession,
}) => {
  await gotoSession()
  await openFile(page, directory, "frontend/workspace/e2e/science/review-report.md")

  const inspector = page.locator('[data-component="artifact-inspector"]')
  await inspector.getByRole("tab", { name: "Review", exact: true }).click()
  const review = inspector.locator('[data-component="publication-review"]')
  await expect(review).toHaveAttribute("data-review-state", "not-run")
  await review.getByRole("button", { name: "Run checks", exact: true }).click()
  await expect(review).toHaveAttribute("data-review-state", "blocked", { timeout: 30_000 })
  await expect(review.getByText("Publication is blocked", { exact: true })).toBeVisible()
  await expect(review.locator('[data-component="publication-finding"]')).not.toHaveCount(0)

  const blockers = () =>
    review
      .locator('[data-component="publication-finding"]')
      .filter({ has: page.getByText("blocking", { exact: true }) })
      .filter({ has: page.getByRole("button", { name: "Override", exact: true }) })
  while ((await blockers().count()) > 0) {
    const before = await blockers().count()
    const finding = blockers().first()
    await finding.getByRole("button", { name: "Override", exact: true }).click()
    await finding.getByLabel(/Override reason for/).fill("Accepted in this preview with an explicit audit record.")
    await finding.getByRole("button", { name: "Confirm overridden", exact: true }).click()
    await expect(blockers()).toHaveCount(before - 1)
  }

  const finalize = review.getByRole("button", { name: "Finalize reviewed bytes", exact: true })
  await expect(finalize).toBeEnabled()
  await finalize.click()
  await expect(review).toHaveAttribute("data-review-state", "finalized")
  await expect(review.getByText(/Finalized by/)).toBeVisible()

  await openFile(page, directory, "frontend/workspace/e2e/science/water.xyz")
  await openFile(page, directory, "frontend/workspace/e2e/science/review-report.md")
  await inspector.getByRole("tab", { name: "Review", exact: true }).click()
  await expect(review).toHaveAttribute("data-review-state", "finalized")
  await expect(review.getByText(/sha256 [a-f0-9]{12}/)).toBeVisible()
})
