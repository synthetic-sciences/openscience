import { expect, test } from "./fixtures"

test("retries a failed server health check immediately and clears the recovery banner", async ({
  page,
  gotoSession,
}) => {
  let available = false
  await page.route("**/global/health", async (route) => {
    if (!available) {
      await route.abort("connectionfailed")
      return
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ healthy: true, version: "e2e" }),
    })
  })

  await gotoSession()
  const recovery = page.getByRole("alert", { name: "Server connection lost" })
  await expect(recovery).toBeVisible()

  available = true
  await recovery.getByRole("button", { name: "Retry Now", exact: true }).click()
  await expect(recovery).toHaveCount(0)
})

test("reconnects the global event stream after the server connection drops", async ({ page, gotoSession }) => {
  let requests = 0
  await page.route("**/global/event", async (route) => {
    requests += 1
    if (requests === 1) {
      await route.abort("connectionfailed")
      return
    }
    await route.continue()
  })

  await gotoSession()
  await expect.poll(() => requests, { timeout: 10_000 }).toBeGreaterThan(1)
})
