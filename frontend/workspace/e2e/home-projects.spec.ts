import { test, expect } from "./fixtures"
import { createSdk, promptSelector } from "./utils"

async function createProject(label: string) {
  const project = await createSdk()
    .global.project.create({ name: `${label} ${Date.now()}`, sources: [] })
    .then((result) => result.data)
  if (!project?.id) throw new Error("Failed to create a managed project")
  return project
}

test("home project search filters the recent list and clears back to it", async ({ page }) => {
  const current = await createProject("Search project")

  await page.goto("/")
  const card = page.locator(`[data-project="${current.id}"]`)
  await expect(card).toBeVisible()

  const search = page.getByRole("searchbox", { name: "Search projects" })
  await search.fill("definitely-not-a-project")
  await expect(page.getByText("No matching projects", { exact: true })).toBeVisible()
  await expect(card).toHaveCount(0)

  // Clearing from either the search field or the no-results recovery restores the list.
  await page.getByRole("button", { name: "Clear search", exact: true }).first().click()
  await expect(card).toBeVisible()
})

test("opening a project resumes its last active session", async ({ page }) => {
  const project = await createProject("Resume project")
  const projectSdk = createSdk(project.worktree)

  const remembered = await projectSdk.session.create({ title: `resume me ${Date.now()}` }).then((result) => result.data)
  const newer = await projectSdk.session.create({ title: `newer session ${Date.now()}` }).then((result) => result.data)
  if (!remembered?.id || !newer?.id) throw new Error("Session create did not return an id")

  try {
    await page.goto(`/${project.id}/session/${newer.id}`)
    await expect(page.locator(promptSelector)).toBeVisible()
    await page.goto(`/${project.id}/session/${remembered.id}`)
    await expect(page.locator(promptSelector)).toBeVisible()
    await page.goto("/")
    await page.locator(`[data-project="${project.id}"]`).click()

    await expect(page).toHaveURL(new RegExp(`/${project.id}/session/${remembered.id}(?:\\?|#|$)`))
  } finally {
    await projectSdk.session.delete({ sessionID: newer.id }).catch(() => undefined)
    await projectSdk.session.delete({ sessionID: remembered.id }).catch(() => undefined)
  }
})

test("new projects expose existing source folders in the create flow", async ({ page }) => {
  await page.goto("/")
  await page.getByRole("button", { name: "New project", exact: true }).click()

  const create = page.getByRole("dialog")
  await expect(create.getByRole("heading", { name: "Create project", exact: true })).toBeVisible()
  await expect(create.getByRole("button", { name: /Add source folders/ })).toBeVisible()
  await expect(page.getByRole("button", { name: "Import existing folder", exact: true })).toHaveCount(0)
  await create.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(create).toHaveCount(0)
})
