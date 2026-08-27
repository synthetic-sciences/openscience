import { expect, test } from "./fixtures"

test.use({ hasTouch: true })

test("keeps the composer and Research menu contained at release viewports", async ({ page, openSession }) => {
  await openSession("e2e responsive composer")

  const sizes = [
    { width: 1440, height: 900 },
    { width: 760, height: 760 },
    { width: 390, height: 760 },
    { width: 320, height: 760 },
  ]

  for (const viewport of sizes) {
    await page.setViewportSize(viewport)

    const composer = page.locator("form.workspace-composer")
    const controls = composer.locator('[data-slot="prompt-controls"]')
    const actions = composer.getByRole("group", { name: "Model and send", exact: true })
    const research = composer.locator(".workspace-composer__research-tools > summary")
    await expect(composer).toBeVisible()
    await research.click()

    const menu = composer.getByRole("group", { name: "Research tools", exact: true })
    await expect(menu).toBeVisible()
    const geometry = await composer.evaluate((form, size) => {
      const box = (selector: string) => {
        const rect = (selector === ":scope" ? form : form.querySelector<HTMLElement>(selector))?.getBoundingClientRect()
        if (!rect) throw new Error(`Missing ${selector}`)
        return {
          x: Math.round(rect.x * 10) / 10,
          y: Math.round(rect.y * 10) / 10,
          width: Math.round(rect.width * 10) / 10,
          height: Math.round(rect.height * 10) / 10,
          right: Math.round(rect.right * 10) / 10,
          bottom: Math.round(rect.bottom * 10) / 10,
        }
      }
      return {
        viewport: size,
        composer: box(":scope"),
        controls: box('[data-slot="prompt-controls"]'),
        actions: box(".workspace-composer__actions"),
        research: box(".workspace-composer__research-tools > summary"),
        model: box("[data-model-settings-trigger]"),
        send: box(".workspace-composer__send"),
        menu: box(".workspace-composer__research-tools-menu"),
        delegation: box('.workspace-composer__research-slider [role="radiogroup"]'),
      }
    }, viewport)

    console.log(`composer-geometry ${JSON.stringify(geometry)}`)
    expect(geometry.composer.x).toBeGreaterThanOrEqual(0)
    expect(geometry.composer.right).toBeLessThanOrEqual(viewport.width)
    expect(geometry.menu.x).toBeGreaterThanOrEqual(0)
    expect(geometry.menu.right).toBeLessThanOrEqual(viewport.width)
    for (const target of [geometry.research, geometry.model, geometry.send]) {
      expect(target.width).toBeGreaterThanOrEqual(44)
      expect(target.height).toBeGreaterThanOrEqual(44)
    }
    expect(geometry.delegation.width).toBeGreaterThanOrEqual(32)
    expect(geometry.delegation.height).toBeGreaterThanOrEqual(32)
    if (viewport.width <= 760) {
      expect(geometry.controls.bottom).toBeLessThanOrEqual(geometry.actions.y)
    }

    await research.click()
    await expect(menu).toBeHidden()
  }
})
