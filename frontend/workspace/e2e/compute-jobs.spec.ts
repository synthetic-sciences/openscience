import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Page } from "@playwright/test"
import { expect, test } from "./fixtures"
import { createSdk, promptSelector, sessionPath, trustProject } from "./utils"

async function openJobs(page: Page) {
  await page.getByRole("button", { name: "Open session compute", exact: true }).click()
  const pane = page.locator(".session-right-pane")
  await pane.getByRole("tab", { name: "Jobs", exact: true }).click()
  await expect(pane.getByText("Research jobs", { exact: true })).toBeVisible()
  return pane
}

test("runs a reproducible local job and captures outputs from the right pane", async ({
  page,
  directory: project,
  openSession,
}) => {
  // Local compute jobs must run inside the project workspace, so stage the
  // working directory beneath the project root rather than in the OS tmp dir.
  const directory = realpathSync(mkdtempSync(path.join(project, ".e2e-compute-")))
  try {
    await openSession()
    await trustProject(createSdk(project), project)

    const pane = await openJobs(page)
    // Kernel cards and jobs share the Compute surface; the kernels tab is the
    // default landing view.
    await expect(pane.getByRole("tab", { name: "Kernels", exact: true })).toBeVisible()

    await pane.getByTitle("New job").click()
    await pane.getByLabel("Job name").fill("Playwright compute smoke")
    await pane.getByLabel("Working directory").fill(directory)
    await pane
      .getByLabel("Command")
      .fill(
        "mkdir -p outputs && printf 'metric,value\\nloss,0.1\\n' > outputs/ui-results.csv && printf 'ui-compute-ok\\n'",
      )
    await pane.getByRole("button", { name: "Resources and reproducibility" }).click()
    await pane.getByLabel("CPU cores").fill("2")
    await pane.getByLabel("Memory in GB").fill("4")
    await pane.getByLabel("Artifact patterns").fill("outputs/**/*.csv")

    // Dispatch is absent until an explicit review of the exact staged command.
    const dispatch = pane.getByRole("button", { name: "Dispatch", exact: true })
    await expect(dispatch).toHaveCount(0)
    await pane.getByRole("button", { name: "Review command", exact: true }).click()
    await expect(pane.getByTestId("dispatch-preview")).toContainText("ui-compute-ok")
    await expect(dispatch).toBeVisible()
    await dispatch.click()

    await expect(pane.getByText("Playwright compute smoke", { exact: true })).toHaveCount(1)
    await expect(pane.locator("pre")).toContainText("ui-compute-ok")
    await expect(pane.getByText(/This computer · succeeded/)).toBeVisible()
    await expect(pane.getByText("Captured outputs", { exact: true })).toBeVisible()
    await expect(pane.getByText("outputs/ui-results.csv", { exact: true })).toBeVisible()
    await expect(pane.getByText("Reproducibility", { exact: true })).toBeVisible()
    await expect(pane.getByRole("button", { name: "Export manifest" })).toBeVisible()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("shows a cancelled run without duplicating its expanded title", async ({ page, directory, openSession }) => {
  await openSession()
  await trustProject(createSdk(directory), directory)

  const pane = await openJobs(page)
  await pane.getByTitle("New job").click()
  await pane.getByLabel("Job name").fill("Playwright cancellation")
  await pane.getByRole("textbox", { name: "Command", exact: true }).fill("sleep 300")
  await pane.getByRole("button", { name: "Review command", exact: true }).click()
  await pane.getByRole("button", { name: "Dispatch", exact: true }).click()

  await expect(pane.getByText("Playwright cancellation", { exact: true })).toHaveCount(1)
  await expect(pane.getByText(/This computer · running/)).toBeVisible()
  await pane.getByTitle("Cancel job").click()

  await expect(pane.getByText(/This computer · cancelled/)).toBeVisible()
  await expect(pane.locator("pre").filter({ hasText: "Run cancelled." })).toBeVisible()
  await expect(pane.getByText("Playwright cancellation", { exact: true })).toHaveCount(1)
})

test("defaults a local compute job to the active research project", async ({ page }) => {
  const first = realpathSync(mkdtempSync(path.join(tmpdir(), "openscience-compute-first-")))
  const project = realpathSync(mkdtempSync(path.join(tmpdir(), "openscience-compute-project-")))
  const firstSdk = createSdk(first)
  const projectSdk = createSdk(project)
  const firstSession = await firstSdk.session.create({ title: "First compute project" }).then((result) => result.data)
  const projectSession = await projectSdk.session
    .create({ title: "Current compute project" })
    .then((result) => result.data)
  if (!firstSession?.id || !projectSession?.id) throw new Error("Session create did not return an id")
  try {
    await trustProject(firstSdk, first)
    await trustProject(projectSdk, project)
    await page.goto(sessionPath(first, firstSession.id))
    await expect(page.locator(promptSelector)).toBeVisible()
    await openJobs(page)

    await page.goto(sessionPath(project, projectSession.id))
    await expect(page.locator(promptSelector)).toBeVisible()
    const pane = await openJobs(page)
    await pane.getByTitle("New job").click()

    await pane.getByLabel("Job name").fill("Project cwd smoke")
    await pane.getByRole("textbox", { name: "Command", exact: true }).fill("pwd")
    await pane.getByRole("button", { name: "Review command", exact: true }).click()
    await pane.getByRole("button", { name: "Dispatch", exact: true }).click()

    await expect(pane.getByText("Project cwd smoke", { exact: true }).first()).toBeVisible()
    await expect(pane.locator("pre")).toContainText(project)
    await expect(pane).toContainText(`Working directory · ${project}`)
  } finally {
    await firstSdk.session.delete({ sessionID: firstSession.id }).catch(() => undefined)
    await projectSdk.session.delete({ sessionID: projectSession.id }).catch(() => undefined)
    rmSync(first, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})
