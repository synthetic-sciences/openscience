import { expect, test } from "bun:test"

test("opening Models does not run a destructive dashboard sync", async () => {
  const source = await Bun.file(new URL("./ProviderKeys.tsx", import.meta.url)).text()

  expect(source).not.toContain("sdk.client.global")
  expect(source).not.toContain("refreshDashboard")
  expect(source).not.toContain("visibilitychange")
  expect(source).toContain("refreshAfterSave")
})
