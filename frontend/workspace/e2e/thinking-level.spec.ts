import { test, expect } from "./fixtures"
import { modelTierCycleSelector, modelVariantCycleSelector, promptSelector } from "./utils"

test("thinking effort starts at standard and reaches the prompt request", async ({ page, sdk, gotoSession }) => {
  await gotoSession()

  await page.addStyleTag({
    content: `${modelVariantCycleSelector} { display: inline-block !important; }`,
  })

  const button = page.locator(modelVariantCycleSelector)
  const exists = (await button.count()) > 0
  test.skip(!exists, "current model has no variants")
  if (!exists) return

  await expect(button).toBeVisible()
  await expect(button).toHaveText("Thinking")
  await expect(button).toHaveAttribute("aria-label", /thinking effort: standard/i)

  const send = async (options: { variant?: string; tier?: string } = {}) => {
    const request = page.waitForRequest((request) => {
      const path = new URL(request.url()).pathname
      return request.method() === "POST" && /\/session\/[^/]+\/message$/.test(path)
    })
    const token = `E2E_OK_${Date.now()}`
    const prompt = page.locator(promptSelector)
    await prompt.click()
    await page.keyboard.type(`Reply with exactly: ${token}`)
    await page.keyboard.press("Enter")

    const body = (await request).postDataJSON() as { variant?: string; tier?: string }
    expect(body.variant).toBe(options.variant)
    expect(body.tier).toBe(options.tier)
    return token
  }

  const standard = await send()
  await expect(page).toHaveURL(/\/session\/[^/?#]+/, { timeout: 30_000 })
  const sessionID = /\/session\/([^/?#]+)/.exec(page.url())?.[1]
  if (!sessionID) throw new Error(`Failed to parse session id from url: ${page.url()}`)

  const output = async () =>
    sdk.session.messages({ sessionID, limit: 50 }).then((response) =>
      (response.data ?? [])
        .filter((message) => message.info.role === "assistant")
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n"),
    )

  try {
    await expect.poll(output, { timeout: 20_000 }).toContain(standard)

    await button.click()
    await expect(button).toHaveText("low")
    await button.click()
    await expect(button).toHaveText("high")
    await expect(button).toHaveAttribute("aria-label", /thinking effort: high/i)

    const tier = page.locator(modelTierCycleSelector)
    await tier.locator('[data-slot="switch-control"]').click()
    await expect(tier).toHaveText("Fast")
    await expect(tier.locator('[data-slot="switch-input"]')).toHaveAttribute("aria-checked", "true")

    const high = await send({ variant: "high", tier: "fast" })
    await expect.poll(output, { timeout: 20_000 }).toContain(high)

    await page.reload()
    await expect(button).toHaveText("high")
    await expect(tier).toHaveText("Fast")
    await expect(tier.locator('[data-slot="switch-input"]')).toHaveAttribute("aria-checked", "true")
  } finally {
    await sdk.session.delete({ sessionID }).catch(() => undefined)
  }
})
