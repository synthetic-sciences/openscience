import { test, expect } from "./fixtures"

test("credentials settings exposes provider connection controls", async ({ page, gotoSession }) => {
  await gotoSession()

  await page.getByRole("button", { name: "settings", exact: true }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByRole("button", { name: "Credentials", exact: true }).click()

  await expect(dialog.getByRole("heading", { name: "Credentials" })).toBeVisible()
  await expect(dialog.getByRole("heading", { name: "Provider keys" })).toBeVisible()
  await expect(dialog.getByText("Sign in with ChatGPT", { exact: true }).first()).toBeVisible()
  await expect(dialog.getByPlaceholder("sk-…")).toBeVisible()
  await expect(dialog.getByRole("button", { name: "save key" })).toBeDisabled()

  await dialog.getByRole("button", { name: "Close" }).click()
  await expect(dialog).toHaveCount(0)
})

test("credentials settings saves and removes a local provider key", async ({ page, gotoSession, sdk }) => {
  await sdk.auth.remove({ providerID: "openai" }).catch(() => undefined)

  try {
    await gotoSession()
    await page.getByRole("button", { name: "settings", exact: true }).click()
    const dialog = page.getByRole("dialog")
    await dialog.getByRole("button", { name: "Credentials", exact: true }).click()

    await dialog.locator("select").selectOption("openai")
    await dialog.getByPlaceholder("sk-…").fill("sk-e2e-local-only")
    await dialog.getByRole("button", { name: "save key", exact: true }).click()

    await expect
      .poll(async () => {
        const response = await sdk.provider.list()
        return response.data?.connected.includes("openai")
      })
      .toBe(true)
    await expect(dialog.getByText("OpenAI", { exact: true }).last()).toBeVisible()

    page.once("dialog", (prompt) => prompt.accept())
    const row = dialog.getByText("OpenAI", { exact: true }).last().locator("xpath=../..")
    await row.getByRole("button", { name: "remove", exact: true }).click()
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
