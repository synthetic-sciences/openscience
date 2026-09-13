import { test, expect } from "./fixtures"
import { openSettings } from "./utils"

async function openSkills(page: import("@playwright/test").Page) {
  // Skills live in the settings dialog now, not a top-level tab.
  const dialog = await openSettings(page)
  await dialog.getByRole("button", { name: "Skills", exact: true }).click()
  await expect(dialog.getByRole("region", { name: "Skills settings" })).toBeVisible()
  return dialog
}

test("skills can be searched and disabled", async ({ page, gotoSession }) => {
  await gotoSession()
  const dialog = await openSkills(page)

  await expect(dialog.getByText(/\d+ active/).first()).toBeVisible()
  await expect(dialog.getByText(/\d+ in library/).first()).toBeVisible()

  const search = dialog.getByPlaceholder("Search skills")
  // Exercise search against the catalog the runtime actually returned. Skill
  // bundles can differ across source, packaged, and signed-in installations.
  const firstSkill = dialog.getByRole("listitem").first()
  const slug = (await firstSkill.locator("code").innerText()).trim()
  expect(slug).toMatch(/^\/[a-z0-9-]+$/)
  const knownSkill = slug.slice(1)
  await search.fill(knownSkill)
  const skill = dialog.getByRole("listitem").filter({ hasText: `/${knownSkill}` })
  await expect(skill).toBeVisible()

  const toggle = skill.locator('[data-action="skill-toggle"]')
  await expect(toggle).toBeVisible()
  const initiallyEnabled = (await toggle.getAttribute("data-checked")) !== null
  await toggle.click()
  await expect.poll(async () => (await toggle.getAttribute("data-checked")) !== null).toBe(!initiallyEnabled)
  await toggle.click()
  await expect.poll(async () => (await toggle.getAttribute("data-checked")) !== null).toBe(initiallyEnabled)
  // The checked state is optimistic. Wait until both serialized config writes
  // (and their instance disposals) have completed before this browser context
  // closes, otherwise the next spec can bootstrap against an in-flight reset.
  await expect(skill).not.toHaveAttribute("aria-busy", "true", { timeout: 15_000 })
})

test("skills can be authored from scratch", async ({ page, gotoSession }) => {
  await gotoSession()
  let dialog = await openSkills(page)

  // Both keyboard and pointer users must reach the menu through the dialog's
  // accessible tree. A visually open portal under aria-hidden is not enough.
  const add = dialog.getByRole("button", { name: "Add skill", exact: true })
  await add.focus()
  await add.press("ArrowDown")
  const scratch = dialog.getByRole("menuitem", { name: "Write from scratch", exact: true })
  await expect(scratch).toBeVisible()
  await page.keyboard.press("Home")
  await expect(scratch).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(dialog.getByRole("heading", { name: "Write a new skill" })).toBeVisible()
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click()

  const name = `e2e-skill-${Date.now()}`
  const description = "Created by the isolated browser E2E suite"
  const body = "Run the requested check and report the result."
  const content = `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`
  await add.click()
  await scratch.click()

  await dialog.getByLabel("Name").fill(name)
  await dialog.getByLabel("Description").fill(description)
  await dialog.getByLabel("Instructions (Markdown)").fill(body)
  const saving = page.waitForResponse(
    (response) => response.request().method() === "PUT" && new URL(response.url()).pathname === `/skill/${name}`,
  )
  await dialog.getByRole("button", { name: "Create skill", exact: true }).click()
  const response = await saving
  expect(response.status()).toBe(200)
  expect(response.request().postDataJSON()).toEqual({ content })
  const saved = await response.json()
  expect(saved.name).toBe(name)
  expect(saved.description).toBe(description)

  const search = dialog.getByPlaceholder("Search skills")
  await expect(search).toBeVisible()
  await search.fill(name)
  await expect(
    dialog
      .getByRole("listitem")
      .filter({ hasText: `/${name}` })
      .locator("code"),
  ).toHaveText(`/${name}`)

  await page.reload()
  dialog = await openSkills(page)
  await dialog.getByPlaceholder("Search skills").fill(name)
  await expect(
    dialog
      .getByRole("listitem")
      .filter({ hasText: `/${name}` })
      .locator("code"),
  ).toHaveText(`/${name}`)

  // The Personal view lists what the user wrote, installed, or keeps in the project.
  await dialog.getByPlaceholder("Search skills").fill("")
  const personal = dialog.getByRole("group", { name: "Skill library views" }).getByRole("button", { name: /^Personal/ })
  await personal.click()
  await expect(personal).toHaveAttribute("aria-pressed", "true")
  await expect(
    dialog
      .getByRole("listitem")
      .filter({ hasText: `/${name}` })
      .locator("code"),
  ).toHaveText(`/${name}`)
  await expect(dialog.getByRole("button", { name: `Edit ${name}`, exact: true })).toBeAttached()
})
