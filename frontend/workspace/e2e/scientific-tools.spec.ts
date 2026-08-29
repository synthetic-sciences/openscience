import { expect, test } from "./fixtures"
import { openSettings } from "./utils"

test("shows truthful scientific capability coverage and hosted requirements", async ({ page, gotoSession }) => {
  await gotoSession()
  const dialog = await openSettings(page)

  await dialog.getByRole("button", { name: "Scientific tools", exact: true }).click()
  await expect(dialog.locator("header").getByText("Scientific tools", { exact: true })).toBeVisible()

  const metrics = dialog.locator(".scientific-tools-metrics")
  await expect(metrics).toContainText("Inventoried54")
  await expect(metrics).toContainText("Release-verified0")

  await dialog.getByPlaceholder("Search 54 capabilities").fill("Boltz-2")
  const boltz = dialog.getByRole("button", { name: /Boltz-2/ })
  await expect(boltz).toContainText("Hosted setup")
  await boltz.click()
  await expect(dialog.getByText("BYOK NVIDIA NIM · no shared credential", { exact: true })).toBeVisible()
  await expect(dialog.getByText(/No paid release canary has been recorded/)).toBeVisible()
})
