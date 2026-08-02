import { test, expect } from "./fixtures"
import { promptSelector, sessionTab } from "./utils"

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

test("delegation and specialist controls persist without changing the model", async ({ page, openSession }) => {
  await openSession()

  const model = page.locator("[data-model-settings-trigger]")
  const selected = await model.getAttribute("aria-label")
  const capabilities = page.getByRole("button", { name: "Research capabilities", exact: true })

  await capabilities.click()
  const delegation = page.getByRole("menuitemcheckbox", { name: "Delegation", exact: true })
  await expect(delegation).toHaveAttribute("aria-checked", "true")
  await delegation.click()
  await expect(delegation).toHaveAttribute("aria-checked", "false")

  await capabilities.click()
  await capabilities.click()
  await expect(delegation).toHaveAttribute("aria-checked", "false")
  await delegation.click()
  await expect(delegation).toHaveAttribute("aria-checked", "true")

  await page.getByRole("menuitem", { name: /^Specialist Research/ }).click()
  await page.getByRole("menuitemradio", { name: /^Biology/ }).click()
  await expect(page.getByRole("menuitem", { name: /^Specialist Biology/ })).toBeVisible()

  await capabilities.click()
  await capabilities.click()
  await expect(page.getByRole("menuitem", { name: /^Specialist Biology/ })).toBeVisible()
  await page.getByRole("menuitem", { name: /^Specialist Biology/ }).click()
  await page.getByRole("menuitemradio", { name: /^Research/ }).click()

  await page.getByRole("menuitem", { name: /^Reviewer model Same as session/ }).click()
  const reviewer = page.getByRole("menuitemradio").nth(1)
  const reviewerName = (await reviewer.getByRole("strong").textContent())?.trim()
  if (!reviewerName) throw new Error("Reviewer model picker returned no model")
  await reviewer.click()
  await expect(page.getByRole("menuitem", { name: new RegExp(`^Reviewer model ${reviewerName}`) })).toBeVisible()
  await page.getByRole("menuitem", { name: new RegExp(`^Reviewer model ${reviewerName}`) }).click()
  await page.getByRole("menuitemradio", { name: /^Same as session/ }).click()

  await expect(model).toHaveAttribute("aria-label", selected ?? "")
})

test("session lifecycle works through the sidebar UI", async ({ page, slug, sdk, gotoSession, openSession }) => {
  const renamedTitle = `e2e ui lifecycle ${Date.now()}`
  let sessionID: string | undefined

  try {
    await openSession()

    const newResearch = page.getByRole("button", { name: "New research", exact: true })
    const sidebar = page.getByRole("complementary").filter({ has: newResearch })
    const rows = sidebar.locator('div[role="button"]')
    await expect(sidebar).toBeVisible()
    const baselineCount = await rows.count()

    await newResearch.click()
    await expect(page).toHaveURL(new RegExp(`/${slug}/session/new(?:\\?|#|$)`))
    await expect(rows).toHaveCount(baselineCount)

    const created = await sdk.session.create().then((response) => response.data)
    if (!created?.id || !created.title) throw new Error("Session create returned no id or title")
    sessionID = created.id
    await gotoSession(sessionID)
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
    await expect(sessionTab(page, renamedTitle)).toHaveAttribute("aria-selected", "true")
    await expect(page).toHaveURL(new RegExp(`/${slug}/session/${sessionID}(?:\\?|#|$)`))

    await renamedRow.hover()
    const actions = renamedRow.getByRole("button", { name: "Session actions", exact: true })
    await expect(actions).toBeVisible()
    await actions.click()
    await renamedRow.getByRole("menuitem", { name: "Delete", exact: true }).click()
    const deleteButton = page.getByRole("button", { name: "delete session", exact: true })
    await expect(deleteButton).toBeVisible()
    const deleteResponsePromise = page.waitForResponse((response) => isSessionResponse(response, "DELETE", sessionID))
    await deleteButton.click()
    const deleteResponse = await deleteResponsePromise
    expect(deleteResponse.ok()).toBe(true)

    await expect(renamedRow).toHaveCount(0)
    await expect(rows).toHaveCount(baselineCount)
    await expect(sessionTab(page, renamedTitle)).toHaveCount(0)
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

test("opening Compute from a new route creates a durable session and keeps the surface open", async ({
  page,
  slug,
  sdk,
  openSession,
}) => {
  let sessionID: string | undefined

  try {
    await openSession()
    await page.getByRole("button", { name: "New research", exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/${slug}/session/new(?:\\?|#|$)`))

    const created = page.waitForResponse((response) => isSessionResponse(response, "POST"))
    await page.getByRole("button", { name: "Open session compute", exact: true }).click()
    const response = await created
    const session = (await response.json()) as { id?: string }
    if (!session.id) throw new Error("Compute session creation returned no id")
    sessionID = session.id

    await expect(page).toHaveURL(new RegExp(`/${slug}/session/${sessionID}(?:\\?|#|$)`))
    await expect(page.getByRole("region", { name: "Compute", exact: true })).toBeVisible()
    await expect(page.getByRole("tab", { name: "Kernels", exact: true })).toHaveAttribute("aria-selected", "true")
  } finally {
    if (sessionID) await sdk.session.delete({ sessionID }).catch(() => undefined)
  }
})
