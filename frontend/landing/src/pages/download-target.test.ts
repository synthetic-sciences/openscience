import { describe, expect, test } from "bun:test"
import { detectTarget, targetForArchitecture } from "./download-target"

describe("download target detection", () => {
  test("uses an explicit Intel architecture in the user agent", () => {
    expect(detectTarget("Mozilla/5.0 (Macintosh; x86_64 Mac OS X 10_15_7)")).toBe("mac-x64")
  })

  test("uses reliable ARM Client Hints", () => {
    expect(targetForArchitecture("mac-unknown", "arm")).toBe("mac-arm64")
  })

  test("leaves macOS architecture unknown without Client Hints", () => {
    expect(detectTarget("Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:143.0) Gecko/20100101 Firefox/143.0")).toBe(
      "mac-unknown",
    )
    expect(
      detectTarget(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.6 Safari/605.1.15",
      ),
    ).toBe("mac-unknown")
  })

  test("preserves Windows detection", () => {
    expect(detectTarget("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows-x64")
  })

  test("preserves Linux architecture detection", () => {
    expect(detectTarget("Mozilla/5.0 (X11; Linux x86_64)")).toBe("linux-x64")
    expect(detectTarget("Mozilla/5.0 (X11; Linux aarch64)")).toBe("linux-arm64")
  })
})
