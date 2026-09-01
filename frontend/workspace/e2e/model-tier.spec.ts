import { test, expect } from "./fixtures"
import { modelRowValue, promptSelector, setModelSpeed } from "./utils"

test.skip(
  process.env.OPENSCIENCE_E2E_FAKE_MODEL !== "1",
  "requires the deterministic model supplied by test:e2e:local (or the E2E CI harness)",
)

test("model speed toggles through model options and reaches the prompt request", async ({ page, sdk, gotoSession }) => {
  await gotoSession()

  // Speed and thinking effort are independent. Both stay available in the
  // compact model-options popover without opening the full model catalog.
  await expect(modelRowValue(page, "speed")).resolves.toBe("Standard")
  await expect(modelRowValue(page, "effort")).resolves.toBe("Provider default")

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
  await expect(page).toHaveURL(/\/session\/ses[^/?#]+/, { timeout: 30_000 })
  const sessionID = /\/session\/(ses[^/?#]+)/.exec(page.url())?.[1]
  if (!sessionID) throw new Error(`Failed to parse session id from url: ${page.url()}`)
  try {
    await expect.poll(() => output(sessionID), { timeout: 20_000 }).toContain(standard)

    await setModelSpeed(page, "fast")
    await expect(modelRowValue(page, "speed")).resolves.toBe("Fast")

    await page.reload()
    await expect(modelRowValue(page, "speed")).resolves.toBe("Fast")

    const fast = await send("fast")
    await expect.poll(() => output(sessionID), { timeout: 20_000 }).toContain(fast)
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible({ timeout: 20_000 })

    const command = page.waitForRequest((request) => {
      const path = new URL(request.url()).pathname
      return request.method() === "POST" && /\/session\/[^/]+\/command$/.test(path)
    })
    const prompt = page.locator(promptSelector)
    // Set the complete custom command in one input event. Character-by-character
    // typing opens the slash palette after `/e2`, which deliberately moves focus
    // while filtering and can truncate the rest of synthetic keyboard input.
    await prompt.fill("/e2e-tier-override ")
    await page.getByRole("button", { name: "Send", exact: true }).click()

    const body = (await command).postDataJSON() as { model?: string; tier?: string }
    expect(body.model).toBe("e2e/echo")
    expect(body.tier).toBe("fast")

    await expect.poll(() => output(sessionID), { timeout: 20_000 }).toContain("E2E_TIER_COMMAND_echo-other_standard")
  } finally {
    await sdk.session.delete({ sessionID }).catch(() => undefined)
  }
})
