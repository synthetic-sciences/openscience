import { expect, test } from "./fixtures"

test("does not claim the server is lost after one transient health failure", async ({ page, gotoSession }) => {
  let available = false
  let requests = 0
  await page.route("**/global/health", async (route) => {
    requests += 1
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
  await expect(recovery).toHaveCount(0)

  available = true
  await expect.poll(() => requests, { timeout: 15_000 }).toBeGreaterThan(1)
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
