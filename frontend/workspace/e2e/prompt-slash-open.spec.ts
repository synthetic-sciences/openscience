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

test("inline goal and plan modes preserve the whole draft and caret", async ({ page, gotoSession, sdk }) => {
  const created = await sdk.session.create({ title: `e2e inline modes ${Date.now()}` }).then((r) => r.data)
  if (!created?.id) throw new Error("Failed to create an inline mode fixture")

  try {
    await gotoSession(created.id)
    const prompt = page.locator(promptSelector)
    await expect(prompt).toBeVisible()

    const caret = (position: number) =>
      prompt.evaluate((editor, offset) => {
        const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
        const range = document.createRange()
        const selection = window.getSelection()
        const locate = (node: Node | null, remaining: number): { node: Node; offset: number } | undefined => {
          if (!node) return
          const length = node.textContent?.length ?? 0
          if (remaining <= length) return { node, offset: remaining }
          return locate(walker.nextNode(), remaining - length)
        }
        const point = locate(walker.nextNode(), offset)

        if (point) {
          range.setStart(point.node, point.offset)
          range.collapse(true)
        }
        if (!point) {
          range.selectNodeContents(editor)
          range.collapse(false)
        }

        selection?.removeAllRanges()
        selection?.addRange(range)
      }, position)

    await prompt.fill("Finish the paper")
    await caret(0)
    await prompt.pressSequentially("/go", { delay: 10 })
    await page.locator('[data-slash-id="command.goal"]').click()
    await expect(prompt).toHaveText("Finish the paper")
    await expect(page.locator('[data-composer-intent="goal"]')).toBeVisible()
    await prompt.pressSequentially("Measure ", { delay: 10 })
    await expect(prompt).toHaveText("Measure Finish the paper")
    await page.getByRole("button", { name: "Exit goal mode" }).click()

    await prompt.fill("Please revise the paper")
    await caret(7)
    await prompt.pressSequentially("/pl", { delay: 10 })
    await page.locator('[data-slash-id="command.plan"]').click()
    await expect(prompt).toHaveText("Please revise the paper")
    await expect(page.locator('[data-composer-intent="plan"]')).toBeVisible()
    await prompt.pressSequentially("carefully ", { delay: 10 })
    await expect(prompt).toHaveText("Please carefully revise the paper")
    await page.getByRole("button", { name: "Exit plan mode" }).click()

    await prompt.fill("Finish the paper ")
    await prompt.pressSequentially("/go", { delay: 10 })
    await page.locator('[data-slash-id="command.goal"]').click()
    await expect(prompt).toHaveText("Finish the paper")
    await prompt.pressSequentially(" today", { delay: 10 })
    await expect(prompt).toHaveText("Finish the paper today")
  } finally {
    await sdk.session.delete({ sessionID: created.id }).catch(() => undefined)
  }
})
