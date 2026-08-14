import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { openWorkspaceFile } from "./utils"

async function inspect(page: Page, relativePath: string) {
  await openWorkspaceFile(page, relativePath)
  await page.getByRole("button", { name: "Open file details", exact: true }).click()
}

test("opened files drive a contextual artifact inspector without stale state", async ({ page, openSession }) => {
  await openSession()
  await inspect(page, "frontend/workspace/e2e/science/water.xyz")

  const inspector = page.locator('[data-component="artifact-inspector"]')
  await expect(inspector).toBeVisible()
  await expect(inspector.getByRole("tablist", { name: "File details", exact: true })).toBeVisible()
  await expect(inspector).toHaveAttribute("data-artifact-id", /water\.xyz/)
  await expect(inspector.locator("header strong")).toHaveText("water.xyz")
  await expect(inspector.getByRole("tab")).toHaveCount(7)
  expect((await inspector.boundingBox())?.width).toBeGreaterThanOrEqual(340)

  const details = inspector.getByRole("tab", { name: "Details", exact: true })
  await details.focus()
  await details.press("ArrowRight")
  await expect(inspector.getByRole("tab", { name: "Code", exact: true })).toHaveAttribute("aria-selected", "true")
  await expect(inspector.locator("pre")).toContainText("water")

  await inspector.getByRole("tab", { name: "Run", exact: true }).click()
  await expect(inspector.getByText("No generating run is recorded", { exact: true })).toBeVisible()

  await inspect(page, "frontend/workspace/e2e/science/alignment.fasta")
  await expect(inspector).toHaveAttribute("data-artifact-id", /alignment\.fasta/)
  await expect(inspector.locator("header strong")).toHaveText("alignment.fasta")
  await expect(inspector.getByRole("tab", { name: "Details", exact: true })).toHaveAttribute("aria-selected", "true")

  // Closing Details returns to the file that owns it — the inspector itself
  // is gone, while the file preview remains available in the shared tab strip.
  await page.getByRole("button", { name: "Close context", exact: true }).click()
  await expect(inspector).toHaveCount(0)
  await expect(page.locator(".session-right-pane")).toHaveCount(1)
  await expect(page.getByRole("tab", { name: "Preview", exact: true })).toHaveAttribute("aria-selected", "true")
})

test("right pane stays inline at desktop widths and overlays below the breakpoint", async ({ page, openSession }) => {
  await page.setViewportSize({ width: 1280, height: 760 })
  await openSession()
  await openWorkspaceFile(page, "frontend/workspace/e2e/science/water.xyz")

  const pane = page.locator(".session-right-pane")
  const conversation = page.locator('[data-component="conversation-center"]')
  // Inline (not overlaid) at desktop widths: the pane holds its minimum width
  // and sits to the right of the conversation without covering it.
  await expect(pane).toHaveAttribute("data-overlay", "false")
  const [paneBox, centerBox] = await Promise.all([pane.boundingBox(), conversation.boundingBox()])
  expect(paneBox?.width).toBeGreaterThanOrEqual(360)
  expect(centerBox?.width).toBeGreaterThan(200)
  expect(paneBox?.x).toBeGreaterThan(centerBox?.x ?? 0)

  // Below the inline breakpoint the pane overlays the conversation instead of
  // crushing it. Escape dismisses the overlay and returns to the conversation.
  await page.setViewportSize({ width: 820, height: 760 })
  await expect(pane).toHaveAttribute("data-overlay", "true")
  await expect(page.locator(".session-right-pane-backdrop")).toHaveCount(1)
  await page.keyboard.press("Escape")
  // Open file tabs stay mounted so their editor state survives a temporary
  // mobile dismissal. The gate, rather than the retained pane node, owns
  // visibility after Escape.
  await expect(page.locator(".right-pane-gate")).toHaveAttribute("data-open", "false")
  await expect(pane).toBeHidden()
  await expect(page.locator(".session-right-pane-backdrop")).toHaveCount(0)
})

test("artifact review threads persist and can be resolved", async ({ page, openSession }) => {
  await openSession()
  await inspect(page, "frontend/workspace/e2e/science/water.xyz")

  const inspector = page.locator('[data-component="artifact-inspector"]')
  await inspector.getByRole("tab", { name: "Review", exact: true }).click()
  await expect(inspector.getByText("No annotations yet", { exact: true })).toBeVisible()

  await inspector.getByLabel("New annotation").fill("Confirm the O–H bond length before publication.")
  await inspector.getByRole("button", { name: "Add annotation", exact: true }).click()
  const thread = inspector.locator('[data-component="artifact-annotation"]').filter({ hasText: "Confirm the O–H" })
  await expect(thread).toBeVisible()
  await expect(inspector.getByText("1 open", { exact: true })).toBeVisible()
  await expect(thread.getByText("Annotation version 1", { exact: true })).toBeVisible()
  await expect(thread.getByText("History · 1 revisions", { exact: true })).toBeVisible()

  await thread.getByRole("button", { name: "Resolve", exact: true }).click()
  await expect(thread.getByText("Resolved", { exact: true })).toBeVisible()
  await expect(thread.getByText("Annotation version 2", { exact: true })).toBeVisible()

  await thread.getByRole("button", { name: "Edit", exact: true }).click()
  await inspector.getByLabel(/Edit annotation/).fill("O–H bond length verified against the source structure.")
  await inspector.getByRole("button", { name: "Save edit", exact: true }).click()
  const updated = inspector
    .locator('[data-component="artifact-annotation"]')
    .filter({ hasText: "O–H bond length verified against the source structure." })
  await expect(
    updated.getByText("O–H bond length verified against the source structure.", { exact: true }),
  ).toBeVisible()
  await expect(updated.getByText("Annotation version 3", { exact: true })).toBeVisible()
  await expect(updated.getByText("History · 3 revisions", { exact: true })).toBeVisible()

  await inspect(page, "frontend/workspace/e2e/science/alignment.fasta")
  await inspect(page, "frontend/workspace/e2e/science/water.xyz")
  await inspector.getByRole("tab", { name: "Review", exact: true }).click()
  await expect(
    inspector.getByText("O–H bond length verified against the source structure.", { exact: true }),
  ).toBeVisible()
  await expect(inspector.getByText("0 open", { exact: true })).toBeVisible()
})

test("publication preflight blocks, audits overrides, finalizes, and persists exact manuscript bytes", async ({
  page,
  openSession,
}) => {
  await openSession()
  await inspect(page, "frontend/workspace/e2e/science/review-report.md")

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
      .filter({ has: page.getByText(/^blocking$/i) })
      .filter({ has: page.getByRole("button", { name: "Override", exact: true }) })
  while ((await blockers().count()) > 0) {
    const before = await blockers().count()
    const finding = blockers().first()
    await finding.getByRole("button", { name: "Override", exact: true }).click()
    await finding.getByLabel(/Override reason for/).fill("Accepted in this preview with an explicit audit record.")
    await finding.getByRole("button", { name: "Confirm overridden", exact: true }).click()
    await expect(blockers()).toHaveCount(before - 1)
  }

  const finalize = review.getByRole("button", { name: "Finalize preflight-checked bytes", exact: true })
  await expect(finalize).toBeEnabled()
  await finalize.click()
  await expect(review).toHaveAttribute("data-review-state", "finalized")
  await expect(review.getByText(/Finalized by/)).toBeVisible()

  await inspect(page, "frontend/workspace/e2e/science/water.xyz")
  await inspect(page, "frontend/workspace/e2e/science/review-report.md")
  await inspector.getByRole("tab", { name: "Review", exact: true }).click()
  await expect(review).toHaveAttribute("data-review-state", "finalized")
  await expect(review.getByText(/sha256 [a-f0-9]{12}/)).toBeVisible()
})
