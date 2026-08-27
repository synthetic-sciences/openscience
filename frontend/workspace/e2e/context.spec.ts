import { test, expect } from "./fixtures"
import { openSettings } from "./utils"

test("internal session traces stay out of the normal workspace", async ({ page, gotoSession }) => {
  await gotoSession()
  await expect(page.getByRole("button", { name: "Open session trace", exact: true })).toHaveCount(0)

  const dialog = await openSettings(page)
  await dialog.getByRole("button", { name: "General", exact: true }).click()
  await expect(dialog.getByRole("switch", { name: "Show Trace", exact: true })).toHaveCount(0)
})
