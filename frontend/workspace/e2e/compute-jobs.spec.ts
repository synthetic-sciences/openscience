import type { Page } from "@playwright/test"
import { expect, test } from "./fixtures"

const completedJob = {
  id: "job_completed_e2e",
  name: "Completed remote result",
  command: "python train.py",
  target: { kind: "modal" },
  target_label: "Modal",
  scheduler: "none",
  status: "succeeded",
  created_at: "2026-08-08T10:00:00.000Z",
  started_at: "2026-08-08T10:00:01.000Z",
  completed_at: "2026-08-08T10:01:01.000Z",
  exit_code: 0,
  resources: { cpus: 4, gpus: 1, memory_gb: 16 },
  artifacts: [
    {
      path: "model.pkl",
      size: 10,
      sha256: "a".repeat(64),
      modified_at: "2026-08-08T10:01:01.000Z",
    },
  ],
  lifecycle: { execution: "succeeded", delivery: "delivered", resource: "closed", recoverable: false },
  modal: {
    app: "openscience",
    image: "python:3.12",
    gpu: "A100",
    network: "none",
    timeout_minutes: 10,
    uploads: [],
    upload_bytes: 0,
    approval: "b".repeat(64),
    sdk: "1",
  },
}

async function openCompute(page: Page) {
  await page.getByRole("button", { name: "Open project compute", exact: true }).click()
  const surface = page.getByRole("region", { name: "Compute", exact: true })
  await expect(surface).toBeVisible()
  return surface
}

test("keeps a completed remote result readable in project Compute", async ({ page, openSession }) => {
  await page.route("**/settings/compute/jobs", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([completedJob]) }),
  )

  await openSession()
  const surface = await openCompute(page)

  await expect(surface.getByText("Completed remote result", { exact: true })).toBeVisible()
  await expect(surface.getByText("Exit 0 · 1 file", { exact: true })).toBeVisible()
  await expect(surface.getByRole("region", { name: "Remote activity", exact: true })).toBeVisible()
  await expect(surface.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0)
})

test("project Compute remains an inventory rather than a second launcher", async ({ page, openSession }) => {
  await page.route("**/settings/compute/jobs", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  )

  await openSession()
  const surface = await openCompute(page)

  await expect(surface.getByRole("region", { name: "Project compute", exact: true })).toBeVisible()
  await expect(surface.getByTitle("New job")).toHaveCount(0)
  await expect(surface.getByRole("tab", { name: "Jobs", exact: true })).toHaveCount(0)
})
