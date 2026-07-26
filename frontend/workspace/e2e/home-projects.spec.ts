import { test, expect } from "./fixtures"
import { promptSelector, sessionPath } from "./utils"

const VIEW_KEY = "thesis-projects-view-v1"
const FAVORITES_KEY = "thesis-project-favorites-v1"
const HIDDEN_KEY = "thesis-project-hidden-v1"

test("home project search, view, favorite, and hide state are functional", async ({ page, directory }) => {
  await page.goto("/")
  const project = page
    .getByRole("main")
    .getByRole("button", { name: new RegExp(directory.split("/").at(-1) ?? "OpenScience") })
    .first()
  await expect(project).toBeVisible()

  const search = page.getByRole("textbox", { name: "search projects" })
  await search.fill("definitely-not-a-project")
  await expect(page.getByText("No matching projects", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "clear search" }).click()
  await expect(project).toBeVisible()

  await page.getByRole("button", { name: "list view" }).click()
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), VIEW_KEY)).toBe("list")
  await page.getByRole("button", { name: "grid view" }).click()
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), VIEW_KEY)).toBe("grid")

  await project.hover()
  await project.getByRole("button", { name: "favorite" }).click()
  await expect
    .poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "[]") as string[], FAVORITES_KEY))
    .toContain(directory)
  await project.hover()
  await project.getByRole("button", { name: "unfavorite" }).click()
  await expect
    .poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "[]") as string[], FAVORITES_KEY))
    .not.toContain(directory)

  await project.hover()
  await project.getByRole("button", { name: "remove from list" }).click()
  await expect(project).toHaveCount(0)
  await expect
    .poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "[]") as string[], HIDDEN_KEY))
    .toContain(directory)

  await page.evaluate((key) => localStorage.removeItem(key), HIDDEN_KEY)
  await page.reload()
  await expect(project).toBeVisible()
})

test("new project opens a folder through the in-app picker", async ({ page, directory }) => {
  await page.goto("/")
  await page.getByRole("button", { name: "new project", exact: true }).first().click()

  const path = page.getByPlaceholder(/paste any absolute path/)
  await expect(path).toBeVisible()
  await path.fill(directory)
  await path.press("Enter")
  await page.getByRole("button", { name: "open this folder", exact: true }).click()

  await expect(page).toHaveURL(sessionPath(directory))
  await expect(page.locator(promptSelector)).toBeVisible()
})
