import { test, expect } from "./fixtures"
import { promptSelector } from "./utils"

test("browser back/forward navigates between sessions", async ({ page, slug, sdk, gotoSession }) => {
  await page.setViewportSize({ width: 1400, height: 800 })

  const stamp = Date.now()
  const oneTitle = `e2e browser history 1 ${stamp}`
  const twoTitle = `e2e browser history 2 ${stamp}`
  const one = await sdk.session.create({ title: oneTitle }).then((r) => r.data)
  const two = await sdk.session.create({ title: twoTitle }).then((r) => r.data)

  if (!one?.id) throw new Error("Session create did not return an id")
  if (!two?.id) throw new Error("Session create did not return an id")

  try {
    await gotoSession(one.id)

    const sidebar = page.getByRole("complementary").filter({ has: page.getByPlaceholder("Search sessions") })
    const target = sidebar.locator('[role="button"]').filter({ hasText: twoTitle })
    await expect(target).toBeVisible()
    await target.scrollIntoViewIfNeeded()
    await target.click()

    await expect(page).toHaveURL(new RegExp(`/${slug}/session/${two.id}(?:\\?|#|$)`))
    await expect(page.locator(promptSelector)).toBeVisible()
    await expect(page.getByRole("tab", { name: twoTitle, exact: true })).toHaveAttribute("aria-selected", "true")

    await page.goBack()

    await expect(page).toHaveURL(new RegExp(`/${slug}/session/${one.id}(?:\\?|#|$)`))
    await expect(page.locator(promptSelector)).toBeVisible()
    await expect(page.getByRole("tab", { name: oneTitle, exact: true })).toHaveAttribute("aria-selected", "true")

    await page.goForward()

    await expect(page).toHaveURL(new RegExp(`/${slug}/session/${two.id}(?:\\?|#|$)`))
    await expect(page.locator(promptSelector)).toBeVisible()
    await expect(page.getByRole("tab", { name: twoTitle, exact: true })).toHaveAttribute("aria-selected", "true")
  } finally {
    await sdk.session.delete({ sessionID: one.id }).catch(() => undefined)
    await sdk.session.delete({ sessionID: two.id }).catch(() => undefined)
  }
})
