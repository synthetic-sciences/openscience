import { expect, test } from "./fixtures"

test("turns a scientific workflow into an editable research brief", async ({ page, gotoSession }) => {
  await page.route("**/file/starters?**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        template: "dose-response",
        directory: "openscience-starters/dose-response",
        notebook: "openscience-starters/dose-response/analysis.ipynb",
        readme: "openscience-starters/dose-response/README.md",
        files: [
          "openscience-starters/dose-response/README.md",
          "openscience-starters/dose-response/analysis.ipynb",
          "openscience-starters/dose-response/data/dose_response.csv",
        ],
      }),
    })
  })
  await gotoSession()

  const launchpad = page.locator('[data-component="research-launchpad"]')
  await expect(launchpad).toBeVisible()
  await expect(launchpad.getByRole("heading", { name: "What are we trying to find out?" })).toBeVisible()
  await expect(launchpad.locator(".research-launchpad__quick-action")).toHaveCount(6)
  await expect(launchpad.getByRole("button", { name: /research files$/ })).toBeVisible()
  await expect(launchpad.getByRole("button", { name: /artifacts$/ })).toHaveCount(0)
  await expect(launchpad.locator("[data-workflow]")).toHaveCount(0)
  await expect(launchpad.locator("[data-starter]")).toHaveCount(0)
  await launchpad.getByRole("button", { name: /Browse all workflows/ }).click()
  await expect(launchpad.locator("[data-workflow]")).toHaveCount(23)
  await expect(launchpad.locator("[data-starter]")).toHaveCount(3)
  await expect(page.locator(".session-right-pane")).toHaveCount(0)

  await launchpad.locator('[data-starter="dose-response"]').click()
  await expect(page.getByText("starter project ready", { exact: true })).toBeVisible()

  await page.getByRole("tab", { name: "Chat", exact: true }).click()
  await launchpad.locator('[data-workflow="analyze-data"]').click()

  const composer = page.locator('[data-component="prompt-input"]')
  await expect(composer).toBeFocused()
  await expect(composer).toContainText("Analyze the relevant dataset in this project")

  await page.reload()
  await expect(launchpad).toBeVisible()
  await launchpad.getByRole("button", { name: /Browse all workflows/ }).click()
  await launchpad.getByRole("button", { name: /Compute 7/ }).click()
  await expect(launchpad.locator("[data-workflow]")).toHaveCount(7)
  await expect(launchpad.locator('[data-workflow="protein-design"]')).toBeVisible()
  await expect(launchpad.locator('[data-workflow="molecular-docking"]')).toBeVisible()
  await expect(launchpad.locator('[data-workflow="train-model"]')).toBeVisible()
})

test("recovers starter controls when the local server request drops", async ({ page, gotoSession }) => {
  await page.route("**/file/starters?**", (route) => route.abort("connectionfailed"))
  await gotoSession()

  await page.getByRole("button", { name: /Browse all workflows/ }).click()
  const starter = page.locator('[data-starter="single-cell"]')
  await starter.click()
  await expect(page.getByText("starter could not be created", { exact: true })).toBeVisible()
  await expect(starter).toBeEnabled()
})
