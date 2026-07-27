import { describe, expect, test } from "bun:test"
import { npmDistTag, opensciencePackageSpec } from "../../../../tooling/launcher/lib/channel.mjs"

describe("synsci launcher npm channel", () => {
  test("installs OpenScience from the test dist-tag for test launcher builds", () => {
    expect(npmDistTag("1.3.5-test.42")).toBe("test")
    expect(npmDistTag("0.0.0-test-202607260856")).toBe("test")
    expect(opensciencePackageSpec("1.3.5-test.42")).toBe("@synsci/openscience@test")
  })

  test("keeps stable launcher builds on latest", () => {
    expect(npmDistTag("1.3.5")).toBe("latest")
    expect(opensciencePackageSpec("1.3.5")).toBe("@synsci/openscience@latest")
  })
})
