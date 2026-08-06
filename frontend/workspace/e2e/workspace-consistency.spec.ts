import { expect, test } from "./fixtures"

test("keeps Files and Customize labels visually consistent", async ({ page, gotoSession }) => {
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
    ["Specialists", "Add specialist"],
    ["Compute", "Add host"],
    ["Network", "Add"],
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
})
