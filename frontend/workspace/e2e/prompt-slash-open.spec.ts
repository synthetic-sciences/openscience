import { test, expect } from "./fixtures"
import { promptSelector } from "./utils"

test("smoke slash menu exposes session actions", async ({ page, gotoSession, sdk }) => {
  const created = await sdk.session.create({ title: `e2e slash menu ${Date.now()}` }).then((r) => r.data)
  if (!created?.id) throw new Error("Failed to create a session fixture")

  try {
    await gotoSession(created.id)

    const prompt = page.locator(promptSelector)
    await expect(prompt).toBeVisible()
    await prompt.click()
    await expect(prompt).toBeFocused()
    await prompt.pressSequentially("/compact", { delay: 10 })
    await expect(prompt).toContainText("/compact")

    const command = page.locator('[data-slash-id="command.compact"]')
    await expect(command).toBeVisible()

    await page.keyboard.press("Escape")
    await expect(command).toHaveCount(0)
  } finally {
    await sdk.session.delete({ sessionID: created.id }).catch(() => undefined)
  }
})

test("an inline slash skill preserves text before and after the token", async ({ page, gotoSession, sdk }) => {
  const created = await sdk.session.create({ title: `e2e inline skill ${Date.now()}` }).then((r) => r.data)
  if (!created?.id) throw new Error("Failed to create an inline skill fixture")

  try {
    await gotoSession(created.id)
    const prompt = page.locator(promptSelector)
    await expect(prompt).toBeVisible()
    await prompt.click()
    await expect(prompt).toBeFocused()
    await prompt.pressSequentially("Please use /rev", { delay: 10 })

    const skill = page.locator('[data-slash-id="skill.review"]')
    await expect(skill).toBeVisible()
    await skill.click()
    await expect(prompt).toContainText("Please use /review")

    await prompt.pressSequentially("before finalizing", { delay: 10 })
    await expect(prompt).toContainText("Please use /review before finalizing")
  } finally {
    await sdk.session.delete({ sessionID: created.id }).catch(() => undefined)
  }
})
