import { test, expect } from "./fixtures"
import { serverUrl } from "./utils"

interface AtlasGraphNode {
  node_id: string
}

test("Gateway bridge stays internal while its availability contract remains structured", async ({
  page,
  gotoSession,
}) => {
  await gotoSession()

  // Gateway is an internal bridge, not a public workspace action. Keep the
  // backend contract covered without restoring the retired product surface.
  await expect(page.getByRole("button", { name: "Open Gateway", exact: true })).toHaveCount(0)

  const response = await page.request.get(`${serverUrl}/api/atlas/graphs`)
  if (response.ok()) {
    const body = (await response.json()) as { nodes?: AtlasGraphNode[] }
    expect(Array.isArray(body.nodes)).toBe(true)
    if (process.env.OPENSCIENCE_E2E_ATLAS_REQUIRED === "1") expect(body.nodes!.length).toBeGreaterThan(0)
    return
  }

  if (process.env.OPENSCIENCE_E2E_ATLAS_REQUIRED === "1") {
    throw new Error(`Required Gateway bridge returned ${response.status()}`)
  }
  expect([401, 404, 502]).toContain(response.status())
  const body = (await response.json()) as { detail?: string }
  expect(body.detail).toBeTruthy()
})
