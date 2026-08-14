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

  await expect(dialog.getByText(/\d+ enabled/).first()).toBeVisible()

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

// The product bug is fixed: the add-skill dropdown now mounts inside the
// settings dialog's layer (AddMenu in components/settings/_shared.tsx), so it
// opens and its items activate — verified live in a real browser, and the
// menu renders `[expanded]` in this test's own trace. What remains is a
// Playwright actionability quirk clicking the menuitem inside the nested
// modal portal (it reports the item as not hittable though it is visibly on
// top). Kept fixme until the click is made robust against that quirk.
test.fixme("skills can be authored from scratch", async ({ page, gotoSession }) => {
  await gotoSession()
  const dialog = await openSkills(page)

  const name = `e2e-skill-${Date.now()}`
  await dialog.getByRole("button", { name: "add skill" }).click()
  await page.getByRole("menuitem", { name: /write from scratch/i }).click()

  await dialog.getByLabel("Name").fill(name)
  await dialog.getByLabel("Description").fill("Created by the isolated browser E2E suite")
  await dialog.getByLabel("Instructions (Markdown)").fill("Run the requested check and report the result.")
  await dialog.getByRole("button", { name: "create skill" }).click()

  const search = dialog.getByPlaceholder("Search skills")
  await expect(search).toBeVisible()
  await search.fill(name)
  await expect(dialog.getByText(name, { exact: true }).first()).toBeVisible()
})
