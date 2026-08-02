import { test, expect } from "./fixtures"
import { openSettings } from "./utils"

async function setTrace(page: Parameters<typeof openSettings>[0], enabled: boolean) {
  const dialog = await openSettings(page)
  await dialog.getByRole("button", { name: "General", exact: true }).click()

  const trace = dialog.getByRole("switch", { name: "Show Trace", exact: true })
  if ((await trace.isChecked()) !== enabled) {
    await trace.locator("..").locator('[data-slot="switch-control"]').click()
  }

  if (enabled) await expect(trace).toBeChecked()
  if (!enabled) await expect(trace).not.toBeChecked()
  await dialog.getByRole("button", { name: "Close" }).click()
}

test("observable session context opens in the local trace", async ({ page, sdk, gotoSession }) => {
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
        const [providerID = "e2e", modelID = "echo"] = (process.env.OPENSCIENCE_E2E_MODEL ?? "e2e/echo").split("/")
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

    await expect(page.getByRole("button", { name: "Open session trace", exact: true })).toHaveCount(0)
    await setTrace(page, true)
    await page.getByRole("button", { name: "Open session trace", exact: true }).click()

    const trace = page.getByRole("region", { name: "Session trace", exact: true })
    await expect(trace).toBeVisible()
    await expect(trace.getByText("Local observable record", { exact: true })).toBeVisible()
    await expect(trace.getByText("first output", { exact: true })).toBeVisible()
    await expect(trace.getByText("Observable activity", { exact: true })).toBeVisible()
  } finally {
    await setTrace(page, false).catch(() => undefined)
    await sdk.session.delete({ sessionID }).catch(() => undefined)
  }
})
