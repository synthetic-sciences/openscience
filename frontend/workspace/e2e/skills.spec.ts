import { test, expect } from "./fixtures"

test("skills can be searched, disabled, and authored from scratch", async ({ page, gotoSession }) => {
  await gotoSession()
  await page.getByRole("tab", { name: "Skills", exact: true }).click()

  await expect(page.getByRole("heading", { name: "Skills" })).toBeVisible()
  await expect(page.getByText(/\d+ enabled/).first()).toBeVisible()

  const search = page.getByPlaceholder("Search skills")
  // Source-mode runs include the on-disk bundled catalog. The standalone
  // binary intentionally resolves that catalog from Atlas after login, but it
  // always embeds its system skills so account-free installs remain usable.
  const knownSkill = process.env.OPENSCIENCE_E2E_PACKAGED === "1" ? "initialize-atlas-graph" : "scientific-writing"
  await search.fill(knownSkill)
  await expect(page.getByText(knownSkill, { exact: true }).first()).toBeVisible()

  await search.fill("")
  const toggle = page.locator('[data-component="switch"]').first()
  await expect(toggle).toBeVisible()
  const initiallyEnabled = (await toggle.getAttribute("data-checked")) !== null
  await toggle.click()
  await expect.poll(async () => (await toggle.getAttribute("data-checked")) !== null).toBe(!initiallyEnabled)
  await toggle.click()
  await expect.poll(async () => (await toggle.getAttribute("data-checked")) !== null).toBe(initiallyEnabled)

  const name = `e2e-skill-${Date.now()}`
  await page.getByRole("button", { name: "add skill" }).click()
  await page.getByRole("menuitem", { name: /write from scratch/i }).click()

  await page.getByLabel("Name").fill(name)
  await page.getByLabel("Description").fill("Created by the isolated browser E2E suite")
  await page.getByLabel("Instructions (Markdown)").fill("Run the requested check and report the result.")
  await page.getByRole("button", { name: "create skill" }).click()

  await expect(search).toBeVisible()
  await search.fill(name)
  await expect(page.getByText(name, { exact: true }).first()).toBeVisible()
})
