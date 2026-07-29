import { expect, test } from "./fixtures"
import { serverUrl } from "./utils"

test("keeps a slow Evidence load inside the inspector", async ({ page, gotoSession }) => {
  await page.route("**/provenance?**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800))
    await route.continue()
  })
  await gotoSession()

  await page.getByTitle("evidence").click()
  await expect(page.locator(".session-workspace")).toBeVisible()
  await expect(page.locator('.session-right-pane [data-component="evidence-loading"]')).toBeVisible()
  const pane = page.locator(".session-right-pane")
  await expect(pane.getByText("evidence & lineage", { exact: true })).toBeVisible()
  await expect(pane.getByText("No recorded lineage yet", { exact: true })).toBeVisible()
  await expect(pane.getByText(/Local project content stays in Files/)).toBeVisible()
})

test("refreshes Evidence only after deliberate user activity", async ({ page, gotoSession }) => {
  const requests: string[] = []
  page.on("request", (request) => {
    const url = new URL(request.url())
    if (request.method() === "GET" && url.pathname.endsWith("/provenance")) requests.push(request.url())
  })
  await gotoSession()

  await page.getByTitle("evidence").click()
  const pane = page.locator(".session-right-pane")
  await expect(pane.getByText("evidence & lineage", { exact: true })).toBeVisible()
  await expect.poll(() => requests.length).toBe(1)
  await page.waitForTimeout(3_000)
  expect(requests).toHaveLength(1)

  await pane.getByRole("tab", { name: "Atlas", exact: true }).click()
  await pane.getByRole("tab", { name: "Evidence", exact: true }).click()
  await expect.poll(() => requests.length).toBe(2)
})

test("keeps the last Evidence view available when refresh fails", async ({ page, gotoSession }) => {
  await gotoSession()

  await page.getByTitle("evidence").click()
  const pane = page.locator(".session-right-pane")
  await expect(pane.getByText("evidence & lineage", { exact: true })).toBeVisible()
  await page.route("**/provenance?**", (route) =>
    route.fulfill({ status: 503, contentType: "text/plain", body: "provenance temporarily unavailable" }),
  )

  await pane.getByTitle("refresh evidence").click()
  const alert = pane.getByRole("alert")
  await expect(alert).toContainText("Evidence could not refresh. The last available lineage is still shown.")
  await expect(alert.getByRole("button", { name: "retry", exact: true })).toBeVisible()
  await expect(pane.getByText("No recorded lineage yet", { exact: true })).toBeVisible()
})

test("visualizes project lineage and reviewer findings in the evidence pane", async ({
  page,
  request,
  gotoSession,
  directory,
}) => {
  await gotoSession()

  const post = async (path: string, data: object) => {
    const response = await request.post(`${serverUrl}${path}`, {
      params: { directory },
      data,
    })
    expect(response.ok(), await response.text()).toBe(true)
    return (await response.json()) as { id?: string; node?: { id: string } }
  }
  const source = await post("/provenance/nodes", {
    kind: "source",
    label: "Playwright trial registry",
    meta: { doi: "10.1000/playwright" },
  })
  await post("/provenance/nodes", {
    kind: "artifact",
    label: "Playwright result table",
    derived_from: source.id,
  })
  const claim = await post("/provenance/nodes", {
    kind: "claim",
    label: "Playwright response claim",
    derived_from: source.id,
  })
  await post("/provenance/reviews", {
    target: claim.id,
    claim: "Playwright response claim",
    issue: "verified against registry",
    severity: "info",
    evidence: source.id,
    verdict: "supports",
  })

  await page.getByTitle("evidence").click()
  const pane = page.locator(".session-right-pane")
  await expect(pane.getByText("evidence & lineage", { exact: true })).toBeVisible()
  await expect(pane.getByRole("img", { name: "Evidence lineage graph" })).toBeVisible()
  await expect(pane.getByText("outputs", { exact: true })).toBeVisible()
  await expect(pane.getByRole("button", { name: "output", exact: true })).toBeVisible()
  await expect(pane.getByRole("button", { name: "artifact", exact: true })).toHaveCount(0)
  const claimRow = pane.getByRole("button", { name: /Playwright response claim/ }).first()
  await expect(claimRow).toBeVisible()
  await claimRow.click()
  await expect(pane.getByText("supported", { exact: true }).first()).toBeVisible()

  await pane.getByRole("button", { name: "review", exact: true }).click()
  await expect(pane.getByText("verified against registry", { exact: true })).toBeVisible()
  await expect(pane.getByRole("button", { name: "export audit" })).toBeVisible()
  await expect(pane.getByRole("button", { name: "run reviewer audit" })).toBeVisible()
})
