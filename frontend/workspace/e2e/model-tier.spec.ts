import { test, expect } from "./fixtures"
import { modelTierCycleSelector, promptSelector } from "./utils"

test("model service mode cycles through supported modes and reaches the prompt request", async ({
  page,
  sdk,
  gotoSession,
}) => {
  await gotoSession()

  await page.addStyleTag({
    content: `${modelTierCycleSelector} { display: inline-block !important; }`,
  })

  const button = page.locator(modelTierCycleSelector)
  await expect(button).toBeVisible()
  await expect(button).toHaveText("standard")
  await expect(button).toHaveAttribute("aria-label", /cycle tier: standard/i)

  const send = async (tier?: string) => {
    const request = page.waitForRequest((request) => {
      const path = new URL(request.url()).pathname
      return request.method() === "POST" && /\/session\/[^/]+\/message$/.test(path)
    })
    const token = `E2E_OK_${Date.now()}`
    const prompt = page.locator(promptSelector)
    await prompt.click()
    await page.keyboard.type(`Reply with exactly: ${token}`)
    await page.keyboard.press("Enter")

    const body = (await request).postDataJSON() as { tier?: string }
    expect(body.tier).toBe(tier)
    return token
  }

  const standard = await send()
  await expect(page).toHaveURL(/\/session\/[^/?#]+/, { timeout: 30_000 })
  const sessionID = /\/session\/([^/?#]+)/.exec(page.url())?.[1]
  if (!sessionID) throw new Error(`Failed to parse session id from url: ${page.url()}`)
  try {
    await expect
      .poll(
        async () => {
          const messages = await sdk.session.messages({ sessionID, limit: 50 }).then((response) => response.data ?? [])
          return messages
            .filter((message) => message.info.role === "assistant")
            .flatMap((message) => message.parts)
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n")
        },
        { timeout: 20_000 },
      )
      .toContain(standard)

    await button.click()
    await expect(button).toHaveText("fast")
    await expect(button).toHaveAttribute("aria-label", /cycle tier: fast/i)

    await page.reload()
    await expect(button).toHaveText("fast")

    const fast = await send("fast")
    await expect
      .poll(
        async () => {
          const messages = await sdk.session.messages({ sessionID, limit: 50 }).then((response) => response.data ?? [])
          return messages
            .filter((message) => message.info.role === "assistant")
            .flatMap((message) => message.parts)
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n")
        },
        { timeout: 20_000 },
      )
      .toContain(fast)

    const command = page.waitForRequest((request) => {
      const path = new URL(request.url()).pathname
      return request.method() === "POST" && /\/session\/[^/]+\/command$/.test(path)
    })
    const prompt = page.locator(promptSelector)
    await prompt.click()
    await page.keyboard.type("/e2e-tier-override ")
    await page.keyboard.press("Enter")

    const body = (await command).postDataJSON() as { model?: string; tier?: string }
    expect(body.model).toBe("e2e/echo")
    expect(body.tier).toBe("fast")

    await expect
      .poll(
        async () => {
          const messages = await sdk.session.messages({ sessionID, limit: 50 }).then((response) => response.data ?? [])
          return messages
            .filter((message) => message.info.role === "assistant")
            .flatMap((message) => message.parts)
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n")
        },
        { timeout: 20_000 },
      )
      .toContain("E2E_TIER_COMMAND_echo-other_standard")
  } finally {
    await sdk.session.delete({ sessionID }).catch(() => undefined)
  }
})
