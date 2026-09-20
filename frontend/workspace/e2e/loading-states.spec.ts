import { test, expect, type Locator, type Page } from "./fixtures"

// Each surface's real request is held, not mocked, so the loading state is
// measured against the actual layout and the surface it then resolves into.
const schemes = ["dark", "light"] as const

async function useScheme(page: Page, scheme: (typeof schemes)[number]) {
  await page.addInitScript((value: string) => localStorage.setItem("openscience-color-scheme", value), scheme)
}

/** Where the atom's canvas sits against a box and the vertical band it should centre in. */
async function placement(surface: Locator, loader: Locator, band: { top: number; bottom: number }) {
  const handle = await loader.elementHandle()
  if (!handle) throw new Error("The loader is not on the page")
  return surface.evaluate(
    (node, input) => {
      const outer = node.getBoundingClientRect()
      const canvas = input.loader.shadowRoot?.querySelector("canvas")
      if (!canvas) throw new Error("The loader has not drawn its canvas")
      const mark = canvas.getBoundingClientRect()
      return {
        x: mark.x + mark.width / 2 - (outer.x + outer.width / 2),
        y: mark.y + mark.height / 2 - (input.top + input.bottom) / 2,
        overflow: node.scrollHeight - node.clientHeight,
        size: mark.width,
      }
    },
    { loader: handle, ...band },
  )
}

for (const scheme of schemes) {
  test(`a session opens on the loader until its transcript arrives (${scheme})`, async ({
    page,
    openSession,
  }, info) => {
    await useScheme(page, scheme)
    const gate = Promise.withResolvers<void>()
    await page.route(/\/session\/[^/]+\/message(?:\?|$)/, async (route) => {
      await gate.promise
      await route.continue()
    })
    await openSession(`Loading layout ${scheme}`)
    const surface = page.locator('[data-component="conversation-center"]')
    const loader = surface.locator('synsci-loader[caption="Opening session"]')
    await expect(loader.getByRole("progressbar")).toBeVisible()
    // The composer dock reserves the bottom of the conversation column.
    const band = await surface.evaluate((node) => {
      const outer = node.getBoundingClientRect()
      const reserve = parseFloat(getComputedStyle(node.querySelector(".session-empty")!).paddingBottom) - 24
      return { top: outer.top, bottom: outer.bottom - reserve }
    })
    const bounds = await placement(surface, loader, band)
    expect(Math.abs(bounds.x)).toBeLessThanOrEqual(2)
    expect(Math.abs(bounds.y)).toBeLessThanOrEqual(2)
    expect(bounds.overflow).toBeLessThanOrEqual(1)
    expect(bounds.size).toBe(180)
    await page.screenshot({ path: info.outputPath(`session-opening-${scheme}.png`) })
    gate.resolve()
    await expect(loader).toHaveCount(0)
    await expect(page.getByRole("region", { name: "Start a session" })).toBeVisible()
  })

  test(`the inspector holds Files on the loader until the first listing arrives (${scheme})`, async ({
    page,
    openSession,
  }, info) => {
    await useScheme(page, scheme)
    await openSession(`Files loading layout ${scheme}`)
    const gate = Promise.withResolvers<void>()
    await page.route(/\/file\?/, async (route) => {
      await gate.promise
      await route.continue()
    })
    await page.getByRole("button", { name: "Open project files", exact: true }).click()
    const pane = page.locator('[data-component="inspector-loading"]')
    const loader = pane.locator('synsci-loader[caption="Loading files"]')
    await expect(loader.getByRole("progressbar")).toBeVisible()
    const band = await pane.evaluate((node) => {
      const outer = node.getBoundingClientRect()
      return { top: outer.top, bottom: outer.bottom }
    })
    const bounds = await placement(pane, loader, band)
    expect(Math.abs(bounds.x)).toBeLessThanOrEqual(2)
    expect(Math.abs(bounds.y)).toBeLessThanOrEqual(2)
    expect(bounds.overflow).toBeLessThanOrEqual(1)
    expect(bounds.size).toBe(144)
    await page.screenshot({ path: info.outputPath(`inspector-loading-${scheme}.png`) })
    gate.resolve()
    await expect(loader).toHaveCount(0)
    await expect(page.getByRole("region", { name: "Files", exact: true })).toBeVisible()
  })
}
