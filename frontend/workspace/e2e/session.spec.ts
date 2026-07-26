import { test, expect } from "./fixtures"
import { promptSelector } from "./utils"

function isSessionResponse(response: import("@playwright/test").Response, method: string, sessionID?: string) {
  const path = new URL(response.url()).pathname.replace(/\/$/, "")
  const suffix = sessionID ? `/session/${sessionID}` : "/session"
  return response.request().method() === method && path.endsWith(suffix)
}

test("can open an existing session and type into the prompt", async ({ page, sdk, gotoSession }) => {
  const title = `e2e smoke ${Date.now()}`
  const created = await sdk.session.create({ title }).then((r) => r.data)

  if (!created?.id) throw new Error("Session create did not return an id")
  const sessionID = created.id

  try {
    await gotoSession(sessionID)

    const prompt = page.locator(promptSelector)
    await prompt.click()
    await page.keyboard.type("hello from e2e")
    await expect(prompt).toContainText("hello from e2e")
  } finally {
    await sdk.session.delete({ sessionID }).catch(() => undefined)
  }
})

test("session lifecycle works through the sidebar UI", async ({ page, slug, sdk, gotoSession }) => {
  const renamedTitle = `e2e ui lifecycle ${Date.now()}`
  let sessionID: string | undefined

  try {
    await gotoSession()

    const search = page.getByPlaceholder("Search sessions")
    const sidebar = page.getByRole("complementary").filter({ has: search })
    const rows = sidebar.locator('div[role="button"]')
    await expect(sidebar).toBeVisible()
    const baselineCount = await rows.count()

    const createResponsePromise = page.waitForResponse((response) => isSessionResponse(response, "POST"))
    await sidebar.getByRole("button", { name: "New session" }).click()
    const createResponse = await createResponsePromise
    expect(createResponse.ok()).toBe(true)

    const created = (await createResponse.json()) as { id?: string; title?: string }
    if (!created.id || !created.title) throw new Error("UI session create returned no id or title")
    sessionID = created.id

    await expect(page).toHaveURL(new RegExp(`/${slug}/session/${sessionID}(?:\\?|#|$)`))
    await expect(rows).toHaveCount(baselineCount + 1)

    const originalRow = rows.filter({ hasText: created.title })
    await expect(originalRow).toHaveCount(1)
    await originalRow.getByTitle("Double-click to rename").dblclick()

    const editor = rows.locator("input")
    await expect(editor).toBeVisible()
    await expect(editor).toHaveValue(created.title)
    await editor.fill(renamedTitle)
    const renameResponsePromise = page.waitForResponse((response) => isSessionResponse(response, "PATCH", sessionID))
    await editor.press("Enter")
    const renameResponse = await renameResponsePromise
    expect(renameResponse.ok()).toBe(true)

    const renamedRow = rows.filter({ hasText: renamedTitle })
    await expect(renamedRow).toHaveCount(1)
    await expect(rows.filter({ hasText: created.title })).toHaveCount(0)
    await expect(page.getByRole("tab", { name: renamedTitle, exact: true })).toHaveAttribute("aria-selected", "true")
    await expect(page).toHaveURL(new RegExp(`/${slug}/session/${sessionID}(?:\\?|#|$)`))

    await renamedRow.hover()
    const deleteButton = renamedRow.getByRole("button", { name: "delete session" })
    await expect(deleteButton).toBeVisible()
    const deleteResponsePromise = page.waitForResponse((response) => isSessionResponse(response, "DELETE", sessionID))
    await deleteButton.click()
    const deleteResponse = await deleteResponsePromise
    expect(deleteResponse.ok()).toBe(true)

    await expect(renamedRow).toHaveCount(0)
    await expect(rows).toHaveCount(baselineCount)
    await expect(page.getByRole("tab", { name: renamedTitle, exact: true })).toHaveCount(0)
    if (baselineCount === 0) {
      await expect(page).toHaveURL(new RegExp(`/${slug}/session/new(?:\\?|#|$)`))
    } else {
      await expect(page).not.toHaveURL(new RegExp(`/${slug}/session/${sessionID}(?:\\?|#|$)`))
    }
    await expect(page.locator(promptSelector)).toBeVisible()
    await expect
      .poll(async () => (await sdk.session.list()).data?.some((session) => session.id === sessionID) ?? false)
      .toBe(false)
  } finally {
    if (sessionID) await sdk.session.delete({ sessionID }).catch(() => undefined)
  }
})
