import { test, expect } from "./fixtures"
import { createSdk, promptSelector } from "./utils"

test("home project search filters the recent list and clears back to it", async ({ page, directory }) => {
  const current = await createSdk(directory)
    .project.current()
    .then((result) => result.data)
  if (!current?.id) throw new Error("Failed to resolve the current project id")

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

test("existing folder import remains available through the in-app picker", async ({ page, directory, slug }) => {
  await page.goto("/")
  await page.getByRole("button", { name: "Import existing folder", exact: true }).first().click()

  // The path field is the stable accessible contract; its example placeholder
  // may evolve as the picker accepts more path forms.
  const location = page.getByRole("textbox", { name: "Go to path", exact: true })
  await expect(location).toBeVisible()
  await location.fill(directory)
  await location.press("Enter")
  await expect(location).toHaveValue("")
  await page.getByRole("button", { name: "Use this folder", exact: true }).click()

  await expect(page).toHaveURL(new RegExp(`/${slug}/session`))
  await expect(page.locator(promptSelector)).toBeVisible()
})
