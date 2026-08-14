import { test, expect } from "./fixtures"
import { effortChipSelector, modelRowValue, promptSelector, setModelEffort, setModelSpeed } from "./utils"

test("thinking effort and speed reach the prompt request through the settings popover", async ({
  page,
  sdk,
  gotoSession,
}) => {
  await gotoSession()

  // The explicit Standard default stays visible so users can inspect and
  // change thinking effort without opening the full model menu.
  await expect(modelRowValue(page, "effort")).resolves.toBe("Standard")
  await expect(page.locator(effortChipSelector)).toHaveText("Standard")

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

  const output = async (sessionID: string) =>
    sdk.session.messages({ sessionID, limit: 50 }).then((response) =>
      (response.data ?? [])
        .filter((message) => message.info.role === "assistant")
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n"),
    )

  const standard = await send()
  await expect(page).toHaveURL(/\/session\/[^/?#]+/, { timeout: 30_000 })
  const sessionID = /\/session\/([^/?#]+)/.exec(page.url())?.[1]
  if (!sessionID) throw new Error(`Failed to parse session id from url: ${page.url()}`)

  try {
    await expect.poll(() => output(sessionID), { timeout: 20_000 }).toContain(standard)

    await setModelEffort(page, "high")
    await expect(modelRowValue(page, "effort")).resolves.toBe("High")
    await expect(page.locator(effortChipSelector)).toHaveText("High")
    await setModelSpeed(page, "fast")

    const high = await send({ variant: "high", tier: "fast" })
    await expect.poll(() => output(sessionID), { timeout: 20_000 }).toContain(high)

    await page.reload()
    await expect(modelRowValue(page, "effort")).resolves.toBe("High")
    await expect(modelRowValue(page, "speed")).resolves.toBe("Fast")
  } finally {
    await sdk.session.delete({ sessionID }).catch(() => undefined)
  }
})
