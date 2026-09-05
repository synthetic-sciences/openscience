import { expect, test } from "@playwright/test"
import { aliases, headings, slug } from "../src/navigation"
import { readFileSync } from "node:fs"

const config = JSON.parse(readFileSync(new URL("../src/content/openscience/docs.json", import.meta.url), "utf8")) as {
  navigation: { tabs: { groups: { pages: string[] }[] }[] }
}
const pages = config.navigation.tabs.flatMap((tab) => tab.groups.flatMap((group) => group.pages))

test("all pages render with working section links and page metadata", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  for (const name of pages) {
    const source = readFileSync(new URL("../src/content/openscience/" + name + ".mdx", import.meta.url), "utf8")
    const title = source.match(/^title: "(.+)"$/m)![1]
    await page.goto("#/openscience/" + name)
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(title)
    await expect(page).toHaveTitle(title + " · OpenScience Docs")
    for (const heading of headings(source, 3)) await expect(page.locator('[id="' + slug(heading) + '"]')).toHaveCount(1)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
    expect(overflow, name + " must fit the viewport").toBe(false)
  }
  expect(errors).toEqual([])
})

test("section navigation, old links, and back navigation keep the right page", async ({ page }) => {
  await page.goto("#/openscience/sessions")
  await page.getByRole("complementary", { name: "on this page" }).getByRole("link", { name: "Exit codes" }).click()
  await expect(page).toHaveURL(/sessions#exit-codes$/)
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sessions and terminal runs")
  await page.getByRole("link", { name: "Pricing and usage", exact: true }).first().click()
  await page.goBack()
  await expect(page).toHaveURL(/sessions#exit-codes$/)
  for (const [old, current] of Object.entries(aliases)) {
    await page.goto("#/openscience/" + old)
    await expect(page).toHaveURL(new RegExp("/openscience/" + current + "$"))
    await expect(page.getByRole("heading", { level: 1 })).not.toHaveText("Page not found")
  }
  await page.goto("#/openscience/missing")
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Page not found")
})

test("keyboard search selects a result and escape dismisses it", async ({ page }) => {
  await page.goto("#/openscience/index")
  const search = page.getByRole("combobox", { name: "Search documentation" })
  await search.fill("pricing")
  await search.press("Enter")
  await expect(page).toHaveURL(/\/pricing$/)
  await search.fill("no-match-for-this-query")
  await expect(page.getByText("No docs match that query.")).toBeVisible()
  await search.press("Escape")
  await expect(page.getByRole("listbox")).toHaveCount(0)
})

test("mobile navigation, search, and wide tables remain usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("#/openscience/index")
  await expect(page.getByRole("combobox", { name: "Search documentation" })).toBeVisible()
  const menu = page.getByRole("button", { name: "Browse documentation" })
  await expect(menu).toHaveAttribute("aria-expanded", "false")
  await menu.click()
  await page.getByRole("link", { name: "Pricing and usage", exact: true }).first().click()
  await expect(menu).toHaveAttribute("aria-expanded", "false")
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Pricing and usage")
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false)
  await page.screenshot({ path: "test-results/docs-mobile.png", fullPage: false })
})

test("code copy reports success and exports are served", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"])
  await page.goto("#/openscience/quickstart")
  await page.getByRole("button", { name: "Copy code", exact: true }).first().click()
  await expect(page.getByRole("button", { name: "Copy code", exact: true }).first()).toContainText("Copied")
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("npm install -g @synsci/openscience")
  const index = await page.request.get("llms.txt")
  expect(index.ok()).toBe(true)
  expect(await index.text()).toContain("Pricing and usage")
  const full = await page.request.get("llms-full.txt")
  expect(full.ok()).toBe(true)
  expect(await full.text()).toContain("## Ace terms")
  await page.goto("#/openscience/index")
  await page.screenshot({ path: "test-results/docs-desktop.png", fullPage: false })
})

test("tools and skills tabs expose complete catalogs with usable deep links", async ({ page }) => {
  await page.goto("#/openscience/index")
  const sections = page.getByRole("navigation", { name: "documentation sections" })
  await expect(sections.getByRole("link")).toHaveCount(5)
  await sections.getByRole("link", { name: "Explore tools", exact: true }).click()
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Explore tools")
  await page.getByRole("link", { name: "Scientific tool catalog", exact: true }).first().click()
  await page.getByRole("link", { name: "RDKit", exact: true }).click()
  await expect(page).toHaveURL(/tool-catalog#rdkit$/)
  await expect(page.getByRole("heading", { name: "RDKit", exact: true })).toBeVisible()
  await sections.getByRole("link", { name: "Skills", exact: true }).click()
  await page.getByRole("link", { name: "Skill directory", exact: true }).first().click()
  await expect(page.getByRole("link", { name: "peer-review", exact: true })).toHaveAttribute("href", /SKILL.md$/)
  await expect(page.getByRole("columnheader", { name: "What the procedure covers" }).first()).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false)
  await page.getByRole("button", { name: "Browse documentation" }).click()
  await sections.getByRole("link", { name: "Explore tools", exact: true }).click()
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Explore tools")
  await page.screenshot({ path: "test-results/docs-tools-mobile.png", fullPage: false })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.screenshot({ path: "test-results/docs-tools-desktop.png", fullPage: false })
})
