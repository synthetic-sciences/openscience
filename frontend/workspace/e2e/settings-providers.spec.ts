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
