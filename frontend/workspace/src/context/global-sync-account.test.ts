import { describe, expect, test } from "bun:test"

const source = Bun.file(new URL("./global-sync.tsx", import.meta.url)).text()

describe("account summary announcements", () => {
  test("re-notifies account surfaces when the server stores a newer summary", async () => {
    const component = await source
    const handler = component.slice(
      component.indexOf('case "account.updated"'),
      component.indexOf('case "skill.updated"'),
    )
    // The announcement only re-reads; it must never rebuild the provider
    // catalog or dispose instances the way `global.disposed` does.
    expect(handler).toContain("accountRefresh.notifyAfter")
    expect(handler).not.toContain("refreshProviders")
    expect(component).toContain("onAccountRefreshed: accountRefresh.add")
  })
})
