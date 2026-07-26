import { test, expect } from "./fixtures"
import { promptSelector } from "./utils"

test("smoke slash menu exposes session actions", async ({ page, gotoSession, sdk }) => {
  const created = await sdk.session.create({ title: `e2e slash menu ${Date.now()}` }).then((r) => r.data)
  if (!created?.id) throw new Error("Failed to create a session fixture")

  try {
    await gotoSession(created.id)

    await page.locator(promptSelector).click()
    await page.keyboard.type("/compact")

    const command = page.locator('[data-slash-id="session.compact"]')
    await expect(command).toBeVisible()

    await page.keyboard.press("Escape")
    await expect(command).toHaveCount(0)
  } finally {
    await sdk.session.delete({ sessionID: created.id }).catch(() => undefined)
  }
})
