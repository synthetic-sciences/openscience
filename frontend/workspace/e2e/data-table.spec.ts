import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test, expect } from "./fixtures"
import { openConnectedFile } from "./utils"

test("explores, filters, plots, sorts, and exports a scientific CSV", async ({ page, sdk, openSession }) => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "openscience-table-e2e-")))
  const filename = "expression.csv"
  writeFileSync(
    path.join(directory, filename),
    'gene,count,passed,condition\nTP53,12,true,control\nEGFR,4,false,treated\nBRCA1,,true,control\nMYC,20,true,"treated, high"\n',
  )

  try {
    const sessionID = await openSession()
    await sdk.session.filesystem.grant({ sessionID, path: directory, access: "read", scope: "session" })
    await openConnectedFile(page, directory, filename)

    const table = page.locator('[data-component="data-table"]')
    await expect(table).toBeVisible()
    await expect(table.getByText("4 rows", { exact: true })).toBeVisible()
    await expect(table.getByText("treated, high", { exact: true })).toBeVisible()

    const filter = table.getByLabel("Filter rows")
    await filter.fill("EGFR")
    await expect(table.getByText("1 matches", { exact: true })).toBeVisible()
    await expect(table.getByText("EGFR", { exact: true })).toBeVisible()
    await expect(table.getByText("TP53", { exact: true })).toHaveCount(0)

    await filter.fill("")
    await table.locator('[data-action="table-schema"]').click()
    const schema = table.getByRole("region", { name: "Column schema", exact: true })
    await expect(schema.getByText("1 missing", { exact: true })).toBeVisible()
    await expect(schema.getByText("number", { exact: true })).toBeVisible()

    await table.getByTitle("Sort by count").click()
    await table.locator('[data-action="table-plot"]').click()
    await expect(table.getByRole("img", { name: "count histogram" })).toBeVisible()
    await expect(table.getByLabel("Distribution summary").getByText("Mean 12", { exact: true })).toBeVisible()

    const download = page.waitForEvent("download")
    await table.locator('[data-action="table-export"]').click()
    expect((await download).suggestedFilename()).toBe("expression.filtered.csv")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
