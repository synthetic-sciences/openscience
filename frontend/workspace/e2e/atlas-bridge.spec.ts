import { test, expect } from "./fixtures"
import { serverUrl } from "./utils"

test("Atlas canvas distinguishes a connected graph from an unavailable bridge", async ({ page, gotoSession }) => {
  await gotoSession()

  const response = await page.request.get(`${serverUrl}/api/atlas/graphs`)
  const atlasTab = page.getByRole("tab", { name: "atlas", exact: true })
  await atlasTab.click()
  await expect(atlasTab).toHaveAttribute("aria-selected", "true")

  if (response.ok()) {
    const body = (await response.json()) as { nodes?: unknown[] }
    expect(Array.isArray(body.nodes)).toBe(true)
    if (process.env.OPENSCIENCE_E2E_ATLAS_REQUIRED === "1") expect(body.nodes!.length).toBeGreaterThan(0)
    await expect(page.getByRole("alert")).toHaveCount(0)
    await expect(page.getByText("atlas is unavailable", { exact: true })).toHaveCount(0)
    return
  }

  expect([401, 502]).toContain(response.status())
  const body = (await response.json()) as { detail?: string }
  expect(body.detail).toBeTruthy()
  await expect(page.getByRole("alert")).toContainText("atlas is unavailable")
  await expect(page.getByRole("alert")).toContainText(body.detail!)
})
