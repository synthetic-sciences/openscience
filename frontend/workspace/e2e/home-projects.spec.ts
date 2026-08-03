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

  // Two "Clear search" affordances exist while the empty state shows (the
  // search-bar icon and the empty-state button); either restores the list.
  await page.getByRole("button", { name: "Clear search", exact: true }).first().click()
  await expect(card).toBeVisible()
})

test("existing folder import uses the host-native picker", async ({ page, directory, slug }) => {
  const calls: Array<{ kind: string; title: string; multiple: boolean }> = []
  await page.route("**/api/resolve-folder/dialog", async (route) => {
    const body = route.request().postDataJSON() as { kind: string; title: string; multiple: boolean }
    calls.push(body)
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ paths: [directory] }),
    })
  })

  await page.goto("/")
  await page.getByRole("button", { name: "Import existing folder", exact: true }).first().click()

  await expect(page).toHaveURL(new RegExp(`/${slug}/session`))
  await expect(page.locator(promptSelector)).toBeVisible()
  expect(calls).toEqual([{ kind: "folder", title: "open project", multiple: true }])
})
