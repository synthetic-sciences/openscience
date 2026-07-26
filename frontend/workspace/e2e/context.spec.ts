import { test, expect } from "./fixtures"
import { promptSelector } from "./utils"

test("context panel can be opened from the prompt", async ({ page, sdk, gotoSession }) => {
  const title = `e2e smoke context ${Date.now()}`
  const created = await sdk.session.create({ title }).then((r) => r.data)

  if (!created?.id) throw new Error("Session create did not return an id")
  const sessionID = created.id

  try {
    await sdk.session.promptAsync({
      sessionID,
      noReply: true,
      // noReply only persists a user message, but user-message metadata still
      // requires a model id. Pass the suite model explicitly so this setup does
      // not depend on a connected provider or on host-machine credentials.
      model: (() => {
        const [providerID = "e2e", modelID = "echo"] = (process.env.OPENSCIENCE_E2E_MODEL ?? "e2e/echo").split(
          "/",
        )
        return { providerID, modelID }
      })(),
      parts: [
        {
          type: "text",
          text: "seed context",
        },
      ],
    })

    await expect
      .poll(async () => {
        const messages = await sdk.session.messages({ sessionID, limit: 1 }).then((r) => r.data ?? [])
        return messages.length
      })
      .toBeGreaterThan(0)

    await gotoSession(sessionID)

    const contextButton = page
      .locator('[data-component="button"]')
      .filter({ has: page.locator('[data-component="progress-circle"]').first() })
      .first()

    await expect(contextButton).toBeVisible()
    await contextButton.click()

    const dialog = page.getByRole("dialog", { name: "context", exact: true })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText("messages", { exact: true })).toBeVisible()
  } finally {
    await sdk.session.delete({ sessionID }).catch(() => undefined)
  }
})
