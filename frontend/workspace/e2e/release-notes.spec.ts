import type { Locator } from "@playwright/test"
import { test, expect } from "./fixtures"
import pkg from "../package.json" with { type: "json" }

const paragraph =
  "Browse project files, connect working folders, and recover deleted files without starting a conversation. " +
  "Changes update open previews and preserve unsaved edits. Read the full release notes before continuing. "
const releases = [
  { tag_name: pkg.version, name: `v${pkg.version}`, body: paragraph.repeat(30) },
  ...Array.from({ length: 7 }, (_, index) => ({
    tag_name: `2.0.${index + 1}`,
    name: `v2.0.${index + 1}`,
    body: `## Update ${index + 2}\n${Array.from({ length: 25 }, () => `- ${paragraph}`).join("\n")}`,
  })),
]

async function contained(dialog: Locator) {
  const layout = await dialog.evaluate((node) => {
    const outer = node.getBoundingClientRect()
    const body = node.querySelector<HTMLElement>(".release-notes__body")!
    const footer = node.querySelector<HTMLElement>(".release-notes__footer")!
    const header = node.querySelector<HTMLElement>('[data-slot="dialog-description"]')!
    const bounds = body.getBoundingClientRect()
    const bottom = footer.getBoundingClientRect()
    return {
      inside: outer.top >= 0 && outer.bottom <= innerHeight && outer.left >= 0 && outer.right <= innerWidth,
      separated: bounds.top >= header.getBoundingClientRect().bottom - 1 && bounds.bottom <= bottom.top + 1,
      footerInside: bottom.bottom <= outer.bottom + 1,
      bodyHeight: body.clientHeight,
      scrollable: body.scrollHeight > body.clientHeight,
      horizontalOverflow: node.scrollWidth - node.clientWidth,
      controlsInside: Array.from(footer.querySelectorAll("button")).every((button) => {
        const control = button.getBoundingClientRect()
        return (
          control.left >= outer.left &&
          control.right <= outer.right &&
          control.top >= bottom.top &&
          control.bottom <= bottom.bottom
        )
      }),
    }
  })
  expect(layout).toMatchObject({
    inside: true,
    separated: true,
    footerInside: true,
    scrollable: true,
    controlsInside: true,
  })
  expect(layout.bodyHeight).toBeGreaterThan(40)
  expect(layout.horizontalOverflow).toBeLessThanOrEqual(1)
}

for (const viewport of [
  { width: 1280, height: 720 },
  { width: 600, height: 400 },
  { width: 320, height: 568 },
]) {
  test(`long release notes keep navigation visible at ${viewport.width}×${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport)
    await page.addInitScript(() => {
      localStorage.setItem("highlights.v1", JSON.stringify({ version: "2.0.0" }))
      localStorage.setItem("openscience-color-scheme", "dark")
    })
    // Release history is external data; the parser, dialog, settings and layout are real.
    await page.route("**/settings/updates/releases", (route) => route.fulfill({ json: releases }))
    await page.goto("/")
    const dialog = page.getByRole("dialog", { name: /^What's new in/ })
    const body = dialog.getByRole("region", { name: "Release notes", exact: true })
    const footer = dialog.locator(".release-notes__footer")
    await expect(dialog).toBeVisible()
    await expect(body).toBeFocused()
    await contained(dialog)
    const initial = await footer.boundingBox()

    await body.press("PageDown")
    await expect.poll(() => body.evaluate((node) => node.scrollTop)).toBeGreaterThan(0)
    await body.press("End")
    await expect
      .poll(() => body.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop))
      .toBeLessThanOrEqual(1)
    await contained(dialog)
    expect(await footer.boundingBox()).toEqual(initial)
    await page.screenshot({ path: info.outputPath("release-notes-scrolled.png") })

    await dialog.getByRole("button", { name: "Next", exact: true }).click()
    await expect(dialog.getByRole("heading", { name: "Update 2", exact: true })).toBeVisible()
    await expect.poll(() => body.evaluate((node) => node.scrollTop)).toBe(0)
    await contained(dialog)
    const back = await dialog.getByRole("button", { name: "Back", exact: true }).boundingBox()
    const next = await dialog.getByRole("button", { name: "Next", exact: true }).boundingBox()
    expect(back?.y).toBe(next?.y)
    await page.screenshot({ path: info.outputPath("release-notes-next.png") })
    await dialog.getByRole("button", { name: "Back", exact: true }).click()
    await expect(dialog.getByRole("tab", { name: "Page 1 of 8", exact: true })).toHaveAttribute("aria-selected", "true")
    await body.press("ArrowRight")
    await expect(dialog.getByRole("tab", { name: "Page 2 of 8", exact: true })).toHaveAttribute("aria-selected", "true")
    await dialog.getByRole("tab", { name: "Page 8 of 8", exact: true }).click()
    await contained(dialog)
    await dialog.getByRole("button", { name: "Got it", exact: true }).click()
    await expect(dialog).toHaveCount(0)
  })
}
