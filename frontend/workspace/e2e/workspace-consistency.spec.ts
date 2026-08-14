import { rm } from "node:fs/promises"
import { expect, test } from "./fixtures"

test("keeps Files and Customize labels visually consistent", async ({ page, gotoSession }, testInfo) => {
  await gotoSession()

  await page.getByRole("button", { name: "Open project files" }).click()
  const inspector = page.getByRole("complementary", { name: "Research inspector" })
  await expect(inspector).toBeVisible()
  await expect(inspector.locator(".research-inspector__context")).toHaveCount(0)
  await expect(inspector.getByText("Files", { exact: true })).toHaveCount(1)

  await page.getByRole("button", { name: "Customize OpenScience" }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()

  const panels = [
    ["Models"],
    ["Skills", "Add skill"],
    ["Connectors", "Add connector"],
    ["Compute", "Add host"],
    ["Network", "Add domain"],
    ["Permissions"],
    ["Sandbox", "Run self-test"],
    ["Credentials"],
    ["Storage"],
    ["General", "System"],
  ] as const

  for (const [panel, action] of panels) {
    await dialog.getByRole("button", { name: panel, exact: true }).click()
    const title = dialog.locator(".settings-main__header").getByText(panel, { exact: true })
    await expect(title).toBeVisible()
    await expect(title).toHaveCSS("font-family", /Inter/)
    if (!action) continue
    const control = dialog.getByRole("button", { name: action, exact: true }).first()
    await expect(control).toBeVisible()
    await expect(control).toHaveCSS("font-family", /Inter/)
  }

  await dialog.getByRole("button", { name: "Storage", exact: true }).click()
  await dialog.getByRole("button", { name: /^Change location/ }).click()
  const location = dialog.getByRole("textbox", { name: "New data directory", exact: true })
  await expect(location).toBeVisible()
  await expect(location).toHaveCSS("font-family", /Söhne Mono|Sohne Mono|ui-monospace/)
  const move = dialog.getByRole("button", { name: "Move data", exact: true })
  await expect(move).toBeDisabled()

  const target = testInfo.outputPath("relocated-data")
  await rm(target, { recursive: true, force: true })
  try {
    await location.fill(target)
    await expect(move).toBeEnabled()
    await expect(move).toHaveCSS("font-family", /Inter/)
  } finally {
    await rm(target, { recursive: true, force: true })
  }
})

test("keeps destructive confirmations on the workspace type scale", async ({ page, openSession }) => {
  const name = `Delete typography ${Date.now()}`
  await openSession(name)

  const row = page.locator(".session-sidebar__session").filter({ hasText: name })
  await expect(row).toHaveCount(1)
  await row.hover()
  await row.locator(".session-sidebar__session-menu-button").click()
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click()

  const confirmation = page.getByRole("alertdialog")
  const title = confirmation.getByText("Delete this session?", { exact: true })
  await expect(title).toBeVisible()
  await expect(title).toHaveCSS("font-family", /Inter/)
  await expect(title).toHaveCSS("font-size", "16px")
  await expect(title).toHaveCSS("font-weight", "480")
  await expect(title).toHaveCSS("line-height", "28.8px")

  const cancel = confirmation.getByRole("button", { name: "Cancel", exact: true })
  const remove = confirmation.getByRole("button", { name: "Delete session", exact: true })
  await expect(cancel).toBeFocused()
  await expect(cancel).toHaveCSS("font-family", /Inter/)
  await expect(remove).toHaveCSS("font-family", /Inter/)
  await expect(cancel).toHaveCSS("font-size", "12px")
  await expect(remove).toHaveCSS("font-size", "12px")
  await cancel.click()
})
