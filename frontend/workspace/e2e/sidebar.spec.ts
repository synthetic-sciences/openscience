import { test, expect } from "./fixtures"

test("sidebar keeps recent sessions visible without a permanent search field", async ({ page, sdk, gotoSession }) => {
  const stamp = Date.now()
  const oneTitle = `e2e sidebar search alpha ${stamp}`
  const twoTitle = `e2e sidebar search beta ${stamp}`
  const one = await sdk.session.create({ title: oneTitle }).then((r) => r.data)
  const two = await sdk.session.create({ title: twoTitle }).then((r) => r.data)

  if (!one?.id) throw new Error("Session create did not return an id")
  if (!two?.id) throw new Error("Session create did not return an id")

  try {
    await gotoSession(one.id)

    const sidebar = page.getByRole("complementary").filter({ has: page.getByRole("button", { name: "New research" }) })
    await expect(sidebar).toBeVisible()
    await expect(sidebar.getByRole("button", { name: "New research" })).toBeVisible()
    await expect(sidebar.getByPlaceholder("Search sessions")).toHaveCount(0)
    await expect(sidebar.locator('[role="button"]').filter({ hasText: oneTitle })).toBeVisible()
    await expect(sidebar.locator('[role="button"]').filter({ hasText: twoTitle })).toBeVisible()
  } finally {
    await sdk.session.delete({ sessionID: one.id }).catch(() => undefined)
    await sdk.session.delete({ sessionID: two.id }).catch(() => undefined)
  }
})

test.describe("mobile workspace", () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test("sessions open as a drawer instead of squeezing the active pane", async ({ page, gotoSession }) => {
    await gotoSession()

    const sidebar = page.getByRole("complementary").filter({ has: page.getByRole("button", { name: "New research" }) })
    await expect(sidebar).toHaveAttribute("data-mobile-open", "false")

    await page.getByRole("button", { name: "Show sessions" }).click()
    await expect(sidebar).toHaveAttribute("data-mobile-open", "true")
    await expect(sidebar.getByRole("button", { name: "New research" })).toBeVisible()

    await page.getByRole("button", { name: "close sessions" }).click()
    await expect(sidebar).toHaveAttribute("data-mobile-open", "false")
  })
})
