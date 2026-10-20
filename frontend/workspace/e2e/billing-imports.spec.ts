import { expect, test } from "./fixtures"
import { openSettings } from "./utils"

test("a selected billing file persists and can be removed", async ({ page, gotoSession }) => {
  await gotoSession()
  const dialog = await openSettings(page)
  await dialog.getByRole("button", { name: "Usage", exact: true }).click()
  await dialog.getByRole("group", { name: "Usage source" }).getByRole("button", { name: "API keys" }).click()

  const imports = dialog.getByRole("region", { name: "Provider billing imports" })
  await imports.getByRole("button", { name: "Manage billing imports" }).click()
  const account = `Browser file ${Date.now()}`
  const document = {
    schema_version: 1,
    provider: "browser-test",
    account_label: account,
    currency: "USD",
    records: [
      {
        billing_id: `line-${Date.now()}`,
        kind: "charge",
        occurred_at: new Date().toISOString(),
        amount_usd: "0.000289264",
      },
    ],
  }
  await imports.getByLabel("Import billing JSON").setInputFiles({
    name: "billing.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(document)),
  })

  await expect(imports).toContainText(`${account} · 1 records`)
  await expect(imports).toContainText("0 matched · 1 unmatched · 0 ambiguous billing records")
  await page.reload()
  const reopened = await openSettings(page)
  await reopened.getByRole("button", { name: "Usage", exact: true }).click()
  await reopened.getByRole("group", { name: "Usage source" }).getByRole("button", { name: "API keys" }).click()
  const saved = reopened.getByRole("region", { name: "Provider billing imports" })
  await saved.getByRole("button", { name: "Manage billing imports" }).click()
  await expect(saved).toContainText(`${account} · 1 records`)
  await saved.getByRole("button", { name: /^Remove import / }).click()
  await expect(saved).not.toContainText(`${account} · 1 records`)
})
