import { test, expect } from "./fixtures"
import { promptSelector, sessionHeading } from "./utils"

test("sidebar rows open header session tabs that switch by pointer or keyboard", async ({
  page,
  slug,
  sdk,
  gotoSession,
}) => {
  const stamp = Date.now()
  const oneTitle = `e2e sidebar nav 1 ${stamp}`
  const twoTitle = `e2e sidebar nav 2 ${stamp}`
  const one = await sdk.session.create({ title: oneTitle }).then((r) => r.data)
  const two = await sdk.session.create({ title: twoTitle }).then((r) => r.data)

  if (!one?.id) throw new Error("Session create did not return an id")
  if (!two?.id) throw new Error("Session create did not return an id")

  try {
    await gotoSession(one.id)

    const sidebar = page.getByRole("complementary").filter({ has: page.getByRole("button", { name: "New research" }) })
    const target = sidebar.getByRole("button", { name: twoTitle, exact: true })
    await expect(target).toBeVisible()
    await target.scrollIntoViewIfNeeded()
    await target.click()

    await expect(page).toHaveURL(new RegExp(`/${slug}/session/${two.id}(?:\\?|#|$)`))
    const tabs = page.locator(".workspace-tabs").getByRole("tablist")
    const active = tabs.getByRole("tab", { name: new RegExp(`^${twoTitle}`) })
    await expect(active).toHaveAttribute("aria-selected", "true")
    await expect(active).toHaveAttribute("tabindex", "0")
    await expect(page.locator(promptSelector)).toBeVisible()
    await expect(sessionHeading(page, twoTitle)).toBeVisible()

    const ordered = await tabs.getByRole("tab").evaluateAll((items) =>
      items.map((item) => ({
        id: item.getAttribute("data-session-tab"),
        selected: item.getAttribute("aria-selected") === "true",
      })),
    )
    const current = ordered.findIndex((item) => item.selected)
    const next = ordered[(current + 1) % ordered.length]?.id
    if (!next) throw new Error("Session tabs did not expose a keyboard target")

    await active.focus()
    await active.press("ArrowRight")
    const nextTab = tabs.locator(`[role="tab"][data-session-tab="${next}"]`)
    await expect(page).toHaveURL(new RegExp(`/${slug}/session/${next}(?:\\?|#|$)`))
    await expect(nextTab).toHaveAttribute("aria-selected", "true")
    await expect(nextTab).toBeFocused()
  } finally {
    await sdk.session.delete({ sessionID: one.id }).catch(() => undefined)
    await sdk.session.delete({ sessionID: two.id }).catch(() => undefined)
  }
})
