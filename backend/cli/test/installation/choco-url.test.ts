import { describe, expect, test } from "bun:test"
import { Installation } from "../../src/installation"

describe("Installation.chocoLatestVersionUrl", () => {
  test("queries the openscience package, not the pre-rename synsc id", () => {
    const url = Installation.chocoLatestVersionUrl()
    expect(url).toContain(encodeURIComponent("Id eq 'openscience'"))
    expect(url).not.toContain("synsc")
  })

  test("keeps the OData query options ($filter/$select) literal", () => {
    const url = Installation.chocoLatestVersionUrl()
    expect(url.startsWith("https://community.chocolatey.org/api/v2/Packages?$filter=")).toBe(true)
    expect(url).toContain("&$select=Version")
    expect(url).toContain(encodeURIComponent("IsLatestVersion"))
  })
})
