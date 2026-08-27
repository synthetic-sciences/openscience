import { test, expect } from "./fixtures"
import { promptSelector } from "./utils"

test.skip(
  process.env.OPENSCIENCE_E2E_FAKE_MODEL !== "1",
  "requires the deterministic model supplied by test:e2e:local (or the E2E CI harness)",
)

function sessionIDFromUrl(url: string) {
  const match = /\/session\/([^/?#]+)/.exec(url)
  const id = match?.[1]
  return id && id !== "new" ? id : undefined
}

test("can send a prompt and receive a reply", async ({ page, sdk, gotoSession }) => {
  test.setTimeout(45_000)

  const pageErrors: string[] = []
  const onPageError = (err: Error) => {
    pageErrors.push(err.message)
  }
  page.on("pageerror", onPageError)

  await gotoSession()

  const token = `E2E_OK_${Date.now()}`

  const prompt = page.locator(promptSelector)
  await prompt.click()
  await page.keyboard.type(`Reply with exactly: ${token}`)
  await page.keyboard.press("Enter")

  await expect(page).toHaveURL(/\/session\/(?!new(?:[/?#]|$))[^/?#]+/, { timeout: 30_000 })

  const sessionID = (() => {
    const id = sessionIDFromUrl(page.url())
    if (!id) throw new Error(`Failed to parse session id from url: ${page.url()}`)
    return id
  })()

  try {
    await expect
      .poll(
        async () => {
          const messages = await sdk.session.messages({ sessionID, limit: 50 }).then((r) => r.data ?? [])
          return messages
            .filter((m) => m.info.role === "assistant")
            .flatMap((m) => m.parts)
            .filter((p) => p.type === "text")
            .map((p) => p.text)
            .join("\n")
        },
        { timeout: 20_000 },
      )

      .toContain(token)

    const reply = page.locator('[data-slot="session-turn-response-section"]').filter({ hasText: token }).first()
    await expect(reply).toBeVisible({ timeout: 20_000 })
  } finally {
    page.off("pageerror", onPageError)
    await sdk.session.delete({ sessionID }).catch(() => undefined)
  }

  if (pageErrors.length > 0) {
    throw new Error(`Page error(s):\n${pageErrors.join("\n")}`)
  }
})

test("can send the first prompt after New research opens the explicit new-session route", async ({
  page,
  sdk,
  openSession,
}) => {
  test.setTimeout(45_000)
  await openSession()
  await page.getByRole("button", { name: "New research", exact: true }).click()
  await expect(page).toHaveURL(/\/session\/new(?:\?|#|$)/)

  const token = `E2E_OK_${Date.now()}`
  const prompt = page.locator(promptSelector)
  await prompt.click()
  await page.keyboard.type(`Reply with exactly: ${token}`)
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(/\/session\/(?!new(?:[/?#]|$))[^/?#]+/, { timeout: 30_000 })

  const sessionID = sessionIDFromUrl(page.url())
  if (!sessionID || sessionID === "new") throw new Error(`Failed to parse created session id from url: ${page.url()}`)

  try {
    await expect
      .poll(
        () =>
          sdk.session.messages({ sessionID, limit: 50 }).then((response) =>
            (response.data ?? [])
              .filter((message) => message.info.role === "assistant")
              .flatMap((message) => message.parts)
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n"),
          ),
        { timeout: 20_000 },
      )
      .toContain(token)
  } finally {
    await sdk.session.delete({ sessionID }).catch(() => undefined)
  }
})

test("an incomplete provider tool call is recovered without a raw schema error", async ({ page, sdk, gotoSession }) => {
  test.setTimeout(45_000)
  await gotoSession()

  const token = `E2E_TOOL_MALFORMED_${Date.now()}`
  const prompt = page.locator(promptSelector)
  await prompt.click()
  await page.keyboard.type(token)
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(/\/session\/(?!new(?:[/?#]|$))[^/?#]+/, { timeout: 30_000 })

  const sessionID = sessionIDFromUrl(page.url())
  if (!sessionID) throw new Error(`Failed to parse session id from url: ${page.url()}`)

  try {
    await expect
      .poll(
        () =>
          sdk.session.messages({ sessionID, limit: 50 }).then((response) =>
            (response.data ?? [])
              .filter((message) => message.info.role === "assistant")
              .flatMap((message) => message.parts)
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n"),
          ),
        { timeout: 20_000 },
      )
      .toContain(`${token}_DONE`)

    const messages = await sdk.session.messages({ sessionID, limit: 50 }).then((response) => response.data ?? [])
    const payload = JSON.stringify(messages)
    expect(payload).toContain("Recovered incomplete bash call")
    expect(payload).not.toContain("expected string, received undefined")
    expect(payload).not.toContain("Please rewrite the input so it satisfies the expected schema")
    await expect(page.locator("body")).not.toContainText("expected string, received undefined")
    await expect(page.locator("body")).not.toContainText("Please rewrite the input so it satisfies the expected schema")
    await expect(page.getByText(`${token}_DONE`, { exact: false }).first()).toBeVisible()
  } finally {
    await sdk.session.delete({ sessionID }).catch(() => undefined)
  }
})
