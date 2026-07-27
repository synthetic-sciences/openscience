import { describe, expect, test } from "bun:test"
import { Installation } from "../../src/installation"

describe("Installation.npmReleaseChannel", () => {
  test("keeps public prerelease channels on their matching npm dist-tag", () => {
    expect(Installation.npmReleaseChannel("test")).toBe("test")
    expect(Installation.npmReleaseChannel("beta")).toBe("beta")
    expect(Installation.npmReleaseChannel("dev")).toBe("dev")
    expect(Installation.npmReleaseChannel("ci")).toBe("ci")
    expect(Installation.npmReleaseChannel("latest")).toBe("latest")
  })

  test("falls back unknown local branch channels to latest", () => {
    expect(Installation.npmReleaseChannel("codex/npm-test-workflow")).toBe("latest")
    expect(Installation.npmReleaseChannel("feature-branch")).toBe("latest")
  })
})
