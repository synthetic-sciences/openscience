import { describe, expect, test } from "bun:test"
import { requirementArtifacts } from "../../../src/science/kernel/environment-manager"

const hash = (seed: string) => seed.repeat(64).slice(0, 64)
const pin = (name: string, version: string, seed: string) => `${name}==${version} --hash=sha256:${hash(seed)}`

describe("requirementArtifacts", () => {
  test("reads a name, version and hashes from each pin", () => {
    expect(requirementArtifacts(pin("numpy", "1.26.4", "a"))).toEqual([
      { pin: "numpy==1.26.4", name: "numpy", version: "1.26.4", hashes: [hash("a")] },
    ])
  })

  test("ignores comments and blank lines", () => {
    // A comment or an empty line is not a pin. Counting it made the exact
    // coverage check in verifiedWheels fail for an ordinary requirements file.
    const requirements = [
      "# pinned by release 2.0",
      pin("numpy", "1.26.4", "a"),
      "",
      pin("scipy", "1.11.4", "b"),
      "   ",
    ].join("\n")
    expect(requirementArtifacts(requirements).map((item) => item.pin)).toEqual(["numpy==1.26.4", "scipy==1.11.4"])
  })

  test("trims indentation on a pin", () => {
    expect(requirementArtifacts(`    ${pin("polars", "1.9.0", "c")}`)).toEqual([
      { pin: "polars==1.9.0", name: "polars", version: "1.9.0", hashes: [hash("c")] },
    ])
  })

  test("keeps every hash on a pin and returns nothing for empty input", () => {
    const two = `${pin("numpy", "1.26.4", "a")} --hash=sha256:${hash("b")}`
    expect(requirementArtifacts(two)[0]?.hashes).toEqual([hash("a"), hash("b")])
    expect(requirementArtifacts("")).toEqual([])
    expect(requirementArtifacts("   \n  ")).toEqual([])
  })

  // TaskSpec validates pip_requirements only as a non-empty string, so a range
  // or a bare name reaches here. indexOf("==") returned -1 and sliced the name
  // and version out of the wrong offsets, which mis-counted the entry against
  // the pinned packages in verifiedWheels.
  test("rejects a requirement line that carries no == pin", () => {
    expect(requirementArtifacts("requests>=2.31")).toEqual([])
    expect(requirementArtifacts("requests")).toEqual([])
    expect(requirementArtifacts("requests @ https://example.invalid/requests-2.31.0-py3-none-any.whl")).toEqual([])
    expect(requirementArtifacts("~=2.31")).toEqual([])
    expect(requirementArtifacts("-e .")).toEqual([])
    // An environment marker alone is not a pin either.
    expect(requirementArtifacts('numpy==1.26.4 ; python_version >= "3.10"')).toEqual([
      { pin: "numpy==1.26.4", name: "numpy", version: "1.26.4", hashes: [] },
    ])
  })

  test("keeps the valid pins around a line that carries none", () => {
    const requirements = [
      pin("numpy", "1.26.4", "a"),
      "requests>=2.31",
      pin("scipy", "1.11.4", "b"),
    ].join("\n")
    expect(requirementArtifacts(requirements).map((item) => item.pin)).toEqual(["numpy==1.26.4", "scipy==1.11.4"])
  })
})
