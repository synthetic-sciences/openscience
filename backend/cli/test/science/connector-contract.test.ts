import { describe, expect, test } from "bun:test"
import { registry } from "../../src/science/connectors"

// Guards the invariant that makes science_fetch's routing safe: a connector
// either advertises file formats AND can serve them, or does neither.
describe("connector contract", () => {
  test("every connector has the required members", () => {
    for (const c of registry.all()) {
      expect(typeof c.id).toBe("string")
      expect(typeof c.search).toBe("function")
      expect(typeof c.fetch).toBe("function")
    }
  })

  test("formats and fetchFile are declared together or not at all", () => {
    for (const c of registry.all()) {
      expect(Boolean(c.formats?.length)).toBe(typeof c.fetchFile === "function")
    }
  })

  test("formats never contains json", () => {
    for (const c of registry.all()) {
      expect(c.formats ?? []).not.toContain("json")
    }
  })
})
