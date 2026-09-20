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

  test(`the projects route fallback lines up with the page's own loading card (${scheme})`, async ({ page }, info) => {
    await useScheme(page, scheme)
    const readyGate = Promise.withResolvers<void>()
    // Global bootstrap (path/config/catalog/auth, gated here by its first
    // call) is what keeps the page on its own "loading" card once Home
    // mounts -- unlike the two cases above, there is no real request to gate
    // for app.tsx's <Suspense fallback={<LoadingScreen class="science-home__fallback" .../>}>
    // itself: the only resource anywhere under it is FdaBanner's own probe,
    // and FdaBanner checks `!probe.loading` before ever calling `probe()`
    // (atlas/FdaBanner.tsx), so Suspense has nothing pending to catch. A
    // cold "/" load's full request list, traced independently, confirms it:
    // Home's own heading and card are already in the DOM before the probe
    // request is even issued. So the fallback is built here instead, out of
    // the same classes and attributes LoadingScreen/AtomLoader emit, sized to
    // #root -- it draws with the same already-loaded stylesheet and custom
    // element the running page has, and is measured exactly like the card.
    await page.route(/\/global\/health(?:\?|$)/, async (route) => {
      await readyGate.promise
      await route.continue()
    })
    await page.goto("/")

    const card = page.locator(".science-home__state--loading")
    const cardLoader = card.locator('synsci-loader[caption="Loading projects"]')
    await expect(cardLoader.getByRole("progressbar")).toBeVisible()
    // No page band to centre in yet -- just the mark's own absolute height,
    // so it can be compared directly against the fallback's below.
    const cardBounds = await placement(card, cardLoader, { top: 0, bottom: 0 })
    expect(Math.abs(cardBounds.x)).toBeLessThanOrEqual(2)
    expect(cardBounds.overflow).toBeLessThanOrEqual(1)
    expect(cardBounds.size).toBe(144)
    await page.screenshot({ path: info.outputPath(`projects-card-${scheme}.png`) })

    await page.evaluate(() => {
      const root = document.getElementById("root")!
      const rect = root.getBoundingClientRect()
      const cs = getComputedStyle(root)
      const fixture = document.createElement("div")
      fixture.id = "e2e-fallback-fixture"
      Object.assign(fixture.style, {
        position: "fixed",
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        display: cs.display,
        flexDirection: cs.flexDirection,
        paddingTop: cs.paddingTop,
        paddingRight: cs.paddingRight,
        paddingBottom: cs.paddingBottom,
        paddingLeft: cs.paddingLeft,
        pointerEvents: "none",
      })
      // LoadingScreen's own output (frontend/ui/src/components/atom-loader.tsx).
      const host = document.createElement("div")
      host.setAttribute("data-component", "loading-screen")
      host.className = "science-home__fallback"
      host.setAttribute("role", "status")
      host.setAttribute("aria-live", "polite")
      // AtomLoader's own output for size=144 caption="Loading projects", no progress.
      const loader = document.createElement("synsci-loader")
      loader.setAttribute("data-component", "atom-loader")
      loader.setAttribute("role", "img")
      loader.setAttribute("aria-label", "Loading projects")
      loader.style.setProperty("--atom-loader-size", "144px")
      loader.setAttribute("size", "144")
      loader.setAttribute("caption", "Loading projects")
      loader.textContent = "Loading projects"
      host.appendChild(loader)
      fixture.appendChild(host)
      document.body.appendChild(fixture)
    })
    const fallback = page.locator("#e2e-fallback-fixture .science-home__fallback")
    const fallbackLoader = fallback.locator("synsci-loader")
    await expect(fallbackLoader.getByRole("progressbar")).toBeVisible()
    const fallbackBounds = await placement(fallback, fallbackLoader, { top: 0, bottom: 0 })
    expect(Math.abs(fallbackBounds.x)).toBeLessThanOrEqual(2)
    expect(fallbackBounds.size).toBe(144)
    await page.screenshot({ path: info.outputPath(`projects-fallback-${scheme}.png`) })
    await page.evaluate(() => document.getElementById("e2e-fallback-fixture")?.remove())

    // The fallback stands in for this exact card, so their marks must land at
    // the same height -- not each merely centred within its own box.
    expect(Math.abs(fallbackBounds.y - cardBounds.y)).toBeLessThanOrEqual(2)

    readyGate.resolve()
    await expect(card).toHaveCount(0)
    await expect(page.getByRole("button", { name: /new project/i }).first()).toBeVisible()
  })
}
