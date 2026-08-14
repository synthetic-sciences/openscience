import { test, expect } from "./fixtures"
import { openSettings } from "./utils"

test("models settings exposes provider connection controls", async ({ page, gotoSession }) => {
  await gotoSession()

  const dialog = await openSettings(page)

  await expect(dialog.getByRole("heading", { name: "Models", exact: true })).toBeVisible()
  await expect(dialog.getByRole("heading", { name: "Provider keys" })).toBeVisible()
  await expect(dialog.getByText("Sign in with ChatGPT", { exact: true }).first()).toBeVisible()
  await expect(dialog.getByLabel("API key", { exact: true })).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Save key" })).toBeDisabled()

  await dialog.getByRole("button", { name: "Close" }).click()
  await expect(dialog).toHaveCount(0)
})

test("Models keeps ChatGPT Codex access first-class", async ({ page, gotoSession }) => {
  await gotoSession()

  const dialog = await openSettings(page)

  await expect(dialog.getByRole("heading", { name: "Models", exact: true })).toBeVisible()
  await expect(dialog.getByRole("heading", { name: "Access and routing", exact: true })).toBeVisible()
  await expect(dialog.getByText("Sign in with ChatGPT", { exact: true }).first()).toBeVisible()
})

test("models settings saves and removes a local provider key", async ({ page, gotoSession, sdk }) => {
  await sdk.auth.remove({ providerID: "openai" }).catch(() => undefined)

  try {
    await gotoSession()
    const dialog = await openSettings(page)

    await dialog.getByRole("button", { name: /^Model provider / }).click()
    await page
      .locator('[data-slot="select-select-item"]')
      .filter({ hasText: /^OpenAI$/ })
      .click()
    await dialog.getByLabel("API key", { exact: true }).fill("sk-e2e-local-only")
    await dialog.getByRole("button", { name: "Save key", exact: true }).click()

    await expect
      .poll(async () => {
        const response = await sdk.provider.list()
        return response.data?.connected.includes("openai")
      })
      .toBe(true)
    await expect(dialog.getByText("OpenAI", { exact: true }).last()).toBeVisible()

    await dialog
      .getByRole("region", { name: "Provider keys", exact: true })
      .getByRole("button", { name: "Remove", exact: true })
      .click()
    const confirmation = page.getByRole("alertdialog")
    await expect(confirmation.getByText("Remove OpenAI key?", { exact: true })).toBeVisible()
    await confirmation.getByRole("button", { name: "Remove key", exact: true }).click()
    await expect
      .poll(async () => {
        const response = await sdk.provider.list()
        return response.data?.connected.includes("openai")
      })
      .toBe(false)
  } finally {
    await sdk.auth.remove({ providerID: "openai" }).catch(() => undefined)
    await sdk.global.dispose().catch(() => undefined)
  }
})
